import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenRouterAdapter } from "../src/model/openrouter.js";
import { assertModelAdapter } from "../src/model/adapter-contract.js";

test("OpenRouter adapter exposes the model adapter contract and capabilities", () => {
  const adapter = createOpenRouterAdapter({
    provider: "openrouter",
    model: "primary/model",
    fallbackModels: ["fallback/model"],
    apiKeyEnv: "OPENROUTER_API_KEY",
    allowNetwork: false,
    capabilities: { toolCalling: true, jsonMode: true, streaming: false },
    maxContext: 1000
  });

  assert.equal(assertModelAdapter(adapter), adapter);
  assert.deepEqual(adapter.capabilities(), {
    provider: "openrouter",
    toolCalling: true,
    jsonMode: true,
    streaming: false,
    usage: true,
    fallbackModels: ["fallback/model"],
    maxContext: 1000
  });
});

test("OpenRouter adapter retries transient failures, uses fallback model, and records usage", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-model-"));
  const activeTask = { id: "task-model", dir: path.join(cwd, ".agent", "tasks", "task-model") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const requestedModels = [];

  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedModels.push(body.model);
      if (body.model === "primary/model") {
        return {
          ok: false,
          status: 500,
          json: async () => ({})
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Fallback answered." } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 }
        })
      };
    };

    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "primary/model",
      fallbackModels: ["fallback/model"],
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      capabilities: { toolCalling: true }
    });

    const response = await adapter.respond({
      userRequest: "Explain project",
      projectSummary: {
        fileCount: 1,
        packageManager: "npm",
        scripts: ["test"],
        notableFiles: ["package.json"],
        git: "clean",
        memory: null
      },
      tools: {},
      activeTask
    });

    assert.equal(response.message, "Fallback answered.");
    assert.deepEqual(requestedModels, ["primary/model", "fallback/model"]);

    const usageLines = (await readFile(path.join(activeTask.dir, "model-usage.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(usageLines.length, 2);
    assert.equal(usageLines[0].status, "failed");
    assert.equal(usageLines[0].transient, true);
    assert.equal(usageLines[1].status, "ok");
    assert.equal(usageLines[1].fallback, true);
    assert.equal(usageLines[1].usage.total_tokens, 15);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("assertModelAdapter reports missing methods", () => {
  assert.throws(
    () => assertModelAdapter({ respond() {} }),
    /missing required method/
  );
});

test("OpenRouter critique uses JSON mode when available and returns structured output", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-model-json-"));
  const activeTask = { id: "task-json", dir: path.join(cwd, ".agent", "tasks", "task-json") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let requestedBody;

  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      requestedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                status: "needs_attention",
                summary: "Structured critique found one issue.",
                findings: [{ severity: "warning", text: "Review the changed file." }],
                questions: ["Was this verified?"]
              })
            }
          }],
          usage: { total_tokens: 20 }
        })
      };
    };

    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "json/model",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      capabilities: { toolCalling: true, jsonMode: true }
    });

    const result = await adapter.critique({
      activeTask,
      task: { user_request: "Change file" },
      changed_files: ["src/a.js"]
    });

    assert.equal(requestedBody.response_format.type, "json_object");
    assert.equal(result.ok, true);
    assert.equal(result.structured.status, "needs_attention");
    assert.equal(result.structured.findings[0].severity, "warning");
    assert.equal(result.structured.questions[0], "Was this verified?");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter streamText emits tokens from SSE chunks", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-model-stream-"));
  const activeTask = { id: "task-stream", dir: path.join(cwd, ".agent", "tasks", "task-stream") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const tokens = [];

  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        })
      };
    };

    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "stream/model",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      capabilities: { streaming: true }
    });

    const result = await adapter.streamText({
      activeTask,
      messages: [{ role: "user", content: "Say hello" }],
      onToken(token) {
        tokens.push(token);
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.message, "Hello");
    assert.deepEqual(tokens, ["Hel", "lo"]);

    const usage = (await readFile(path.join(activeTask.dir, "model-usage.jsonl"), "utf8")).trim();
    assert.match(usage, /"streaming":true/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});
