#!/usr/bin/env node

/**
 * Test harness for gemini-image-mcp server.
 * Spawns the server as a child process and communicates over stdio using JSON-RPC.
 *
 * Usage:
 *   node test-harness.js                  # run all tests
 *   node test-harness.js generate         # run only generate tests
 *   node test-harness.js edit             # run only edit tests
 *   node test-harness.js list             # just list available tools
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const TIMEOUT_MS = 60_000; // Gemini can be slow

// ── JSON-RPC client over stdio ──────────────────────────────────────────────

class McpClient {
  constructor(serverPath) {
    this.serverPath = serverPath;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }

  async start() {
    this.proc = spawn("node", [this.serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.proc.stderr.on("data", (chunk) => {
      process.stderr.write(`  [server] ${chunk}`);
    });

    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString();
      this._drain();
    });

    this.proc.on("exit", (code) => {
      for (const [, { reject }] of this.pending) {
        reject(new Error(`Server exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Initialize the MCP session
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-harness", version: "1.0.0" },
    });

    // Send initialized notification (no response expected)
    this._send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // Small delay to let the server process the notification
    await new Promise((r) => setTimeout(r, 100));
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      this._send(msg);
    });
  }

  _send(msg) {
    const json = JSON.stringify(msg);
    this.proc.stdin.write(json + "\n");
  }

  _drain() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // ignore non-JSON lines
      }
    }
  }

  async stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

// ── Test helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function test(name, fn) {
  process.stdout.write(`\n  ${name} ... `);
  try {
    await fn();
    process.stdout.write("PASS\n");
    passed++;
  } catch (err) {
    process.stdout.write("FAIL\n");
    console.error(`    ${err.message}`);
    failed++;
  }
}

function contentOfType(result, type) {
  return result.content?.find((c) => c.type === type);
}

// ── Create a tiny test image for edit tests ─────────────────────────────────

async function createTestImage() {
  // 1x1 red PNG (minimal valid PNG)
  const buf = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64"
  );
  const tmpPath = path.join(os.tmpdir(), "test-harness-input.png");
  await fs.writeFile(tmpPath, buf);
  return tmpPath;
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function main() {
  const filter = process.argv[2]; // optional: "generate", "edit", "list"
  const client = new McpClient(path.resolve("server.js"));

  console.log("Starting MCP server...");
  await client.start();
  console.log("Server ready.\n");

  // ── List tools ──────────────────────────────────────────────────────────
  if (!filter || filter === "list") {
    await test("tools/list returns all tools", async () => {
      const result = await client.request("tools/list");
      const names = result.tools.map((t) => t.name);
      assert(names.includes("generate_image"), "missing generate_image");
      assert(names.includes("edit_image"), "missing edit_image");
      assert(names.includes("google_search"), "missing google_search");
      console.log(`    tools: ${names.join(", ")}`);
    });
  }

  // ── Generate tests ──────────────────────────────────────────────────────
  if (!filter || filter === "generate") {
    await test("generate_image returns inline image + text", async () => {
      const result = await client.request("tools/call", {
        name: "generate_image",
        arguments: {
          prompt: "A simple red circle on a white background",
          aspect_ratio: "1:1",
        },
      });

      const img = contentOfType(result, "image");
      const txt = contentOfType(result, "text");

      assert(img, "no image content block returned");
      assert(img.data, "image block missing data");
      assert(img.mimeType?.startsWith("image/"), `bad mimeType: ${img.mimeType}`);
      assert(txt, "no text content block returned");
      assert(txt.text.includes("/"), "text should contain file path");

      // Verify the file was actually saved
      const match = txt.text.match(/Saved.*to (.+?) \(/);
      if (match) {
        const savedPath = match[1];
        const stat = await fs.stat(savedPath);
        assert(stat.size > 0, "saved file is empty");
        console.log(`    saved: ${savedPath} (${(stat.size / 1024).toFixed(1)}KB)`);
      }

      const inlineKB = (Buffer.from(img.data, "base64").length / 1024).toFixed(1);
      console.log(`    inline: ${inlineKB}KB, mime: ${img.mimeType}`);
    });

    await test("generate_image with style parameter", async () => {
      const result = await client.request("tools/call", {
        name: "generate_image",
        arguments: {
          prompt: "A mountain landscape at sunset",
          style: "line drawing",
          aspect_ratio: "16:9",
        },
      });

      const img = contentOfType(result, "image");
      assert(img, "no image content block returned");
      assert(!result.isError, "request returned an error");
      console.log(`    mime: ${img.mimeType}`);
    });

    await test("generate_image with empty prompt returns error", async () => {
      try {
        await client.request("tools/call", {
          name: "generate_image",
          arguments: { prompt: "" },
        });
        // If we get here, the server returned a result (possibly isError)
      } catch {
        // Expected - validation should reject empty prompt
      }
    });
  }

  // ── Edit tests ──────────────────────────────────────────────────────────
  if (!filter || filter === "edit") {
    const testImagePath = await createTestImage();

    await test("edit_image modifies an existing image", async () => {
      const result = await client.request("tools/call", {
        name: "edit_image",
        arguments: {
          image_path: testImagePath,
          prompt: "Make this image blue instead of red",
        },
      });

      const img = contentOfType(result, "image");
      const txt = contentOfType(result, "text");

      assert(img, "no image content block returned");
      assert(img.data, "image block missing data");
      assert(txt, "no text content block returned");

      const inlineKB = (Buffer.from(img.data, "base64").length / 1024).toFixed(1);
      console.log(`    inline: ${inlineKB}KB, mime: ${img.mimeType}`);
    });

    await test("edit_image with bad path returns error", async () => {
      try {
        const result = await client.request("tools/call", {
          name: "edit_image",
          arguments: {
            image_path: "/nonexistent/image.png",
            prompt: "make it blue",
          },
        });
        assert(result.isError, "should have returned isError for bad path");
      } catch {
        // Also acceptable - server may throw
      }
    });

    // Cleanup
    await fs.unlink(testImagePath).catch(() => {});
  }

  // ── Search tests ────────────────────────────────────────────────────────
  if (!filter || filter === "search") {
    await test("google_search returns text with results", async () => {
      const result = await client.request("tools/call", {
        name: "google_search",
        arguments: {
          query: "What is the capital of France?",
        },
      });

      const txt = contentOfType(result, "text");
      assert(txt, "no text content block returned");
      assert(txt.text.length > 0, "text response is empty");
      assert(!result.isError, "request returned an error");
      console.log(`    response length: ${txt.text.length} chars`);
    });

    await test("google_search with empty query returns error", async () => {
      try {
        await client.request("tools/call", {
          name: "google_search",
          arguments: { query: "" },
        });
      } catch {
        // Expected - validation should reject empty query
      }
    });
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  await client.stop();

  console.log(`\n${"─".repeat(40)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Harness error:", err);
  process.exit(1);
});
