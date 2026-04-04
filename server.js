import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const STYLES = ["photorealistic", "digital art", "line drawing", "diagram"];
const MODEL = "gemini-3-pro-image-preview";

function extractImage(result) {
  const parts = result.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) return null;
  return imagePart.inlineData.data; // already base64
}

function buildImageToolResult(base64Data, aspectRatio) {
  return {
    content: [
      {
        type: "image",
        data: base64Data,
        mimeType: "image/png"
      },
      {
        type: "text",
        text: `Image generated (${aspectRatio})`
      }
    ]
  };
}

async function handleGenerateImage(ai, args) {
  const parsed = z.object({
    prompt: z.string().min(1).max(1500),
    aspect_ratio: z.enum(ASPECT_RATIOS).optional().default("1:1"),
    style: z.enum(STYLES).optional()
  }).parse(args);

  const fullPrompt = parsed.style
    ? `${parsed.style}, ${parsed.prompt}, high quality, detailed`
    : `${parsed.prompt}, high quality, detailed`;

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: fullPrompt,
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: parsed.aspect_ratio },
    },
  });

  const base64Data = extractImage(result);
  if (!base64Data) {
    return { content: [{ type: "text", text: "No image returned by Gemini. Try a shorter or simpler prompt." }], isError: true };
  }

  return buildImageToolResult(base64Data, parsed.aspect_ratio);
}

async function handleEditImage(ai, args) {
  const parsed = z.object({
    image_data: z.string().min(1),
    mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]).optional().default("image/png"),
    prompt: z.string().min(1).max(1500),
    aspect_ratio: z.enum(ASPECT_RATIOS).optional()
  }).parse(args);

  const config = { responseModalities: ["TEXT", "IMAGE"] };
  if (parsed.aspect_ratio) {
    config.imageConfig = { aspectRatio: parsed.aspect_ratio };
  }

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: [
      { text: parsed.prompt },
      { inlineData: { mimeType: parsed.mime_type, data: parsed.image_data } },
    ],
    config,
  });

  const base64Data = extractImage(result);
  if (!base64Data) {
    return { content: [{ type: "text", text: "No image returned by Gemini. Try a different edit prompt." }], isError: true };
  }

  return buildImageToolResult(base64Data, parsed.aspect_ratio || "original");
}

function createMcpServer(ai) {
  const server = new Server(
    { name: "gemini-image-mcp", version: "3.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "generate_image",
        description: "Generate an image from a text prompt using Gemini. Returns the image inline as base64.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Image description. Photorealistic, art, diagrams, etc." },
            aspect_ratio: { type: "string", enum: ASPECT_RATIOS, description: "Image aspect ratio (default: 1:1)" },
            style: { type: "string", enum: STYLES, description: "Art style to apply" }
          },
          required: ["prompt"]
        }
      },
      {
        name: "edit_image",
        description: "Edit an existing image using a text prompt. Pass the image as base64-encoded data.",
        inputSchema: {
          type: "object",
          properties: {
            image_data: { type: "string", description: "Base64-encoded image data" },
            mime_type: {
              type: "string",
              enum: ["image/png", "image/jpeg", "image/webp"],
              description: "MIME type of the input image (default: image/png)"
            },
            prompt: { type: "string", description: "Description of the edits to make (e.g. 'add a hat', 'change background to beach')" },
            aspect_ratio: { type: "string", enum: ASPECT_RATIOS, description: "Output aspect ratio (default: preserves original)" }
          },
          required: ["image_data", "prompt"]
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "generate_image": return await handleGenerateImage(ai, args);
        case "edit_image": return await handleEditImage(ai, args);
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `${name} failed: ${error.message}\n\nTips: Use English prompts, keep under 100 words, specify style/lighting for best results.` }],
        isError: true
      };
    }
  });

  return server;
}

export default {
  async fetch(request, env) {
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "GEMINI_API_KEY secret not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    const ai = new GoogleGenAI({ apiKey });
    const server = createMcpServer(ai);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(request);
  }
};
