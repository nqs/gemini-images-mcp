#!/usr/bin/env node

console.error('Gemini Image MCP v3.0 - generate & edit images via Gemini');

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import sharp from "sharp";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY missing - export GEMINI_API_KEY=AIza...");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const IMAGE_DIR = path.join(os.homedir(), ".gemini-images");
const MAX_INLINE_BYTES = 512 * 1024; // 512KB raw (base64 ~ 683KB) to avoid inline rendering limits in clients
const MODEL = "gemini-3-pro-image-preview";

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const STYLES = ["photorealistic", "digital art", "line drawing", "diagram"];

const server = new Server(
  { name: "gemini-image-mcp", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "generate_image",
      description: "Generate an image from a text prompt using Gemini. Returns the image inline and saves to disk.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Image description. Photorealistic, art, diagrams, etc."
          },
          aspect_ratio: {
            type: "string",
            enum: ASPECT_RATIOS,
            description: "Image aspect ratio (default: 1:1)"
          },
          style: {
            type: "string",
            enum: STYLES,
            description: "Art style to apply"
          }
        },
        required: ["prompt"]
      }
    },
    {
      name: "edit_image",
      description: "Edit an existing image using a text prompt. Pass a file path to an image and describe the desired changes.",
      inputSchema: {
        type: "object",
        properties: {
          image_path: {
            type: "string",
            description: "Absolute path to the source image file"
          },
          prompt: {
            type: "string",
            description: "Description of the edits to make (e.g. 'add a hat to the person', 'change the background to a beach')"
          },
          aspect_ratio: {
            type: "string",
            enum: ASPECT_RATIOS,
            description: "Output aspect ratio (default: preserves original)"
          }
        },
        required: ["image_path", "prompt"]
      }
    }
  ]
}));

async function optimizeBuffer(buffer) {
  if (buffer.length <= MAX_INLINE_BYTES) return buffer;
  console.error(`Optimizing ${(buffer.length / 1024) | 0}KB -> <${MAX_INLINE_BYTES / 1024}KB`);

  // Try progressively smaller sizes until under limit
  for (const width of [1024, 768, 512]) {
    const result = await sharp(buffer)
      .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (result.length <= MAX_INLINE_BYTES) return result;
  }

  // Last resort: convert to JPEG
  return sharp(buffer)
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function saveImage(buffer, prefix) {
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const fileName = `${prefix}-${timestamp}-${crypto.randomUUID().slice(0, 8)}.png`;
  const filePath = path.join(IMAGE_DIR, fileName);
  await fs.writeFile(filePath, buffer);
  return { fileName, filePath };
}

function buildImageToolResult(filePath, optimized, aspectRatio) {
  const mimeType = optimized[0] === 0xFF ? "image/jpeg" : "image/png";
  return {
    content: [
      {
        type: "image",
        data: optimized.toString("base64"),
        mimeType
      },
      {
        type: "resource_link",
        resource: {
          uri: `file://${filePath}`,
          description: `Full-resolution image saved to ${filePath} (${aspectRatio})`,
          mimeType,
          size: optimized.length
        }
      },
      {
        type: "text",
        text: `Saved full-resolution image to ${filePath} (${aspectRatio})`
      }
    ]
  };
}

function extractImage(result) {
  const parts = result.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) return null;
  return Buffer.from(imagePart.inlineData.data, "base64");
}

async function handleGenerateImage(args) {
  const parsed = z.object({
    prompt: z.string().min(1).max(1500),
    aspect_ratio: z.enum(ASPECT_RATIOS).optional().default("1:1"),
    style: z.enum(STYLES).optional()
  }).parse(args);

  const fullPrompt = parsed.style
    ? `${parsed.style}, ${parsed.prompt}, high quality, detailed`
    : `${parsed.prompt}, high quality, detailed`;

  console.error(`generate: "${fullPrompt.substring(0, 80)}..."`);

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: fullPrompt,
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: parsed.aspect_ratio,
      },
    },
  });

  const buffer = extractImage(result);
  if (!buffer) {
    return {
      content: [{ type: "text", text: "No image returned by Gemini. Try a shorter or simpler prompt." }],
      isError: true
    };
  }

  const { fileName, filePath } = await saveImage(buffer, "generated");
  const optimized = await optimizeBuffer(buffer);
  const sizeKB = (optimized.length / 1024).toFixed(1);
  console.error(`Saved ${fileName} (${sizeKB}KB inline)`);

  return buildImageToolResult(filePath, optimized, parsed.aspect_ratio);
}

async function handleEditImage(args) {
  const parsed = z.object({
    image_path: z.string().min(1),
    prompt: z.string().min(1).max(1500),
    aspect_ratio: z.enum(ASPECT_RATIOS).optional()
  }).parse(args);

  const imageData = await fs.readFile(parsed.image_path);
  const base64Image = imageData.toString("base64");
  const ext = path.extname(parsed.image_path).toLowerCase();
  const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".webp" ? "image/webp"
    : "image/png";

  console.error(`edit: "${parsed.prompt.substring(0, 80)}..." on ${parsed.image_path}`);

  const config = {
    responseModalities: ["TEXT", "IMAGE"],
  };
  if (parsed.aspect_ratio) {
    config.imageConfig = { aspectRatio: parsed.aspect_ratio };
  }

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: [
      { text: parsed.prompt },
      {
        inlineData: {
          mimeType,
          data: base64Image,
        },
      },
    ],
    config,
  });

  const buffer = extractImage(result);
  if (!buffer) {
    return {
      content: [{ type: "text", text: "No image returned by Gemini. Try a different edit prompt." }],
      isError: true
    };
  }

  const { fileName, filePath } = await saveImage(buffer, "edited");
  const optimized = await optimizeBuffer(buffer);
  const sizeKB = (optimized.length / 1024).toFixed(1);
  console.error(`Saved ${fileName} (${sizeKB}KB inline)`);

  return buildImageToolResult(filePath, optimized, parsed.aspect_ratio || "original");
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "generate_image":
        return await handleGenerateImage(args);
      case "edit_image":
        return await handleEditImage(args);
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true
        };
    }
  } catch (error) {
    console.error(`Error in ${name}:`, error.message);
    return {
      content: [{
        type: "text",
        text: `${name} failed: ${error.message}\n\nTips: Use English prompts, keep under 100 words, specify style/lighting for best results.`
      }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Connected - waiting for requests');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
