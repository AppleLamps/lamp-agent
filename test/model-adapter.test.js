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

test("OpenRouter respond() streams tokens and reassembles tool_calls when capabilities.streaming is true", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-stream-respond-"));
  const activeTask = { id: "task-stream-respond", dir: path.join(cwd, ".agent", "tasks", "task-stream-respond") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const tokens = [];
  let requestedBody = null;

  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    let call = 0;
    globalThis.fetch = async (_url, init) => {
      call += 1;
      requestedBody = JSON.parse(init.body);
      assert.equal(requestedBody.stream, true);
      const encoder = new TextEncoder();
      if (call === 1) {
        // First call: model emits "Looking" text and a tool call delta
        // for `list_files` split across two chunks, then ends with a
        // tool_calls finish_reason.
        return {
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Looking"}}]}\n\n'));
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" up..."}}]}\n\n'));
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"list_","arguments":"{\\""}}]}}]}\n\n'));
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"files","arguments":"path\\":\\".\\""}}]}}]}\n\n'));
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n'));
              controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":50,"completion_tokens":12,"total_tokens":62}}\n\n'));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            }
          })
        };
      }
      // Second call: final reply with a stop finish_reason.
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"All done."}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        })
      };
    };

    const tools = {
      listFiles: async (path) => ({ ok: true, files: [`${path}/x.js`] })
    };

    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "stream/model",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      capabilities: { toolCalling: true, streaming: true }
    });

    const response = await adapter.respond({
      userRequest: "list files",
      projectSummary: { fileCount: 1, scripts: [], notableFiles: [], git: "clean" },
      tools,
      activeTask,
      onToken(token) { tokens.push(token); }
    });

    assert.equal(response.message, "All done.");
    // Tokens from BOTH stream rounds were forwarded in order.
    assert.deepEqual(tokens, ["Looking", " up...", "All done."]);

    const usage = (await readFile(path.join(activeTask.dir, "model-usage.jsonl"), "utf8")).trim();
    assert.match(usage, /"streaming":true/);
    assert.match(usage, /"total_tokens":62/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter respond() falls back to non-streaming when capabilities.streaming is false", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-stream-off-"));
  const activeTask = { id: "task-stream-off", dir: path.join(cwd, ".agent", "tasks", "task-stream-off") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;

  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      // The non-streaming path must NOT request a stream.
      assert.notEqual(body.stream, true);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Plain answer." } }],
          usage: { total_tokens: 7 }
        })
      };
    };

    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "stream/off",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      capabilities: { toolCalling: true, streaming: false }
    });

    const tokens = [];
    const response = await adapter.respond({
      userRequest: "say hi",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "" },
      tools: {},
      activeTask,
      // onToken provided but streaming capability false → ignored.
      onToken(token) { tokens.push(token); }
    });

    assert.equal(response.message, "Plain answer.");
    assert.equal(tokens.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter respond() returns cancelled:true when AbortController fires mid-stream", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-stream-abort-"));
  const activeTask = { id: "task-stream-abort", dir: path.join(cwd, ".agent", "tasks", "task-stream-abort") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const controller = new AbortController();

  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      const encoder = new TextEncoder();
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          async start(streamController) {
            streamController.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Working..."}}]}\n\n'));
            // Trigger the abort just after the first chunk lands.
            await new Promise((r) => setTimeout(r, 10));
            controller.abort();
            // The ReadableStream signal listener (set up via fetch) will
            // close/error the stream. We surface that here for clarity.
            streamController.error(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          }
        })
      };
    };

    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "abort/model",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      capabilities: { toolCalling: true, streaming: true }
    });

    const response = await adapter.respond({
      userRequest: "long task",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "" },
      tools: {},
      activeTask,
      onToken() {},
      signal: controller.signal
    });

    assert.equal(response.cancelled, true);
    assert.match(response.message, /cancelled/i);

    const events = (await readFile(path.join(activeTask.dir, "events.jsonl"), "utf8"))
      .trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(events.some((e) => e.type === "model_aborted"),
      "a model_aborted event should be recorded");
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
