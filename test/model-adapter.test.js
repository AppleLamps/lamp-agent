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

test("OpenRouter adapter sends fallback list in body.models for native fallback", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-model-"));
  const activeTask = { id: "task-model", dir: path.join(cwd, ".agent", "tasks", "task-model") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let requestBody = null;

  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      // OpenRouter served the fallback model server-side: respond with
      // its `model` field set to the fallback to simulate that.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "fallback/model",
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
    // The request body carries the fallback list so OpenRouter can
    // fail over server-side. Primary stays as `body.model`.
    assert.equal(requestBody.model, "primary/model");
    assert.deepEqual(requestBody.models, ["primary/model", "fallback/model"]);

    const usageLines = (await readFile(path.join(activeTask.dir, "model-usage.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(usageLines.length, 1);
    assert.equal(usageLines[0].status, "ok");
    // Usage record reflects the model that actually served the call.
    assert.equal(usageLines[0].model, "fallback/model");
    assert.equal(usageLines[0].fallback, true);
    assert.equal(usageLines[0].native_fallback, true);
    assert.equal(usageLines[0].usage.total_tokens, 15);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter adapter marks last tool with cache_control when routing to Claude with promptCaching", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-cache-"));
  const activeTask = { id: "task-cache", dir: path.join(cwd, ".agent", "tasks", "task-cache") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let requestBody = null;
  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Done." } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        })
      };
    };

    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "anthropic/claude-3-5-sonnet",
      promptCaching: true,
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      capabilities: { toolCalling: true }
    });
    await adapter.respond({
      userRequest: "ping",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "", memory: null },
      tools: {},
      activeTask
    });
    assert.ok(Array.isArray(requestBody.tools) && requestBody.tools.length > 0);
    const lastTool = requestBody.tools[requestBody.tools.length - 1];
    assert.deepEqual(lastTool.cache_control, { type: "ephemeral" });
    const earlierWithCache = requestBody.tools.slice(0, -1).filter((t) => t.cache_control);
    assert.equal(earlierWithCache.length, 0, "only the last tool should carry cache_control");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter adapter does NOT mark cache_control when routing to non-Claude models", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-nocache-"));
  const activeTask = { id: "task-nocache", dir: path.join(cwd, ".agent", "tasks", "task-nocache") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let requestBody = null;
  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Done." } }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
        })
      };
    };
    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      promptCaching: true,
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      capabilities: { toolCalling: true }
    });
    await adapter.respond({
      userRequest: "ping",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "", memory: null },
      tools: {},
      activeTask
    });
    const withCache = (requestBody.tools || []).filter((t) => t.cache_control);
    assert.equal(withCache.length, 0, "non-Claude routes must not get cache_control markers");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter adapter passes reasoning config through to body.reasoning", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-reasoning-"));
  const activeTask = { id: "task-r", dir: path.join(cwd, ".agent", "tasks", "task-r") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let body = null;
  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      };
    };
    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "openai/o3-mini",
      reasoning: { effort: "high", max_tokens: 8000 },
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      capabilities: { toolCalling: true }
    });
    await adapter.respond({
      userRequest: "design a refactor",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "", memory: null },
      tools: {},
      activeTask
    });
    assert.deepEqual(body.reasoning, { effort: "high", max_tokens: 8000 });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter adapter omits body.reasoning when not configured", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-noreason-"));
  const activeTask = { id: "task-nr", dir: path.join(cwd, ".agent", "tasks", "task-nr") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let body = null;
  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      };
    };
    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      capabilities: { toolCalling: true }
    });
    await adapter.respond({
      userRequest: "ping",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "", memory: null },
      tools: {},
      activeTask
    });
    assert.equal(body.reasoning, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter adapter replays priorTurns into the user message for /resume continuity", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-prior-"));
  const activeTask = { id: "task-prior", dir: path.join(cwd, ".agent", "tasks", "task-prior") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let body = null;
  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      };
    };
    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      capabilities: { toolCalling: true }
    });
    await adapter.respond({
      userRequest: "continue",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "", memory: null },
      priorTurns: ["I read user.ts and noticed the bug.", "I'll patch the missing assertion next."],
      tools: {},
      activeTask
    });
    const userMessage = body.messages.find((m) => m.role === "user");
    assert.ok(userMessage, "user message should be present");
    assert.match(userMessage.content, /Earlier in this task, you said:/);
    assert.match(userMessage.content, /\[turn 1\]\nI read user\.ts/);
    assert.match(userMessage.content, /\[turn 2\]\nI'll patch the missing assertion next\./);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter adapter omits the prior-turns preamble when priorTurns is empty", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-noprior-"));
  const activeTask = { id: "task-np", dir: path.join(cwd, ".agent", "tasks", "task-np") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let body = null;
  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      };
    };
    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      capabilities: { toolCalling: true }
    });
    await adapter.respond({
      userRequest: "ping",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "", memory: null },
      priorTurns: [],
      tools: {},
      activeTask
    });
    const userMessage = body.messages.find((m) => m.role === "user");
    assert.equal(/Earlier in this task/.test(userMessage.content), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter adapter appends cwd and platform to the system prompt when environment is provided", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-env-"));
  const activeTask = { id: "task-env", dir: path.join(cwd, ".agent", "tasks", "task-env") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let body = null;
  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      };
    };
    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      capabilities: { toolCalling: true }
    });
    await adapter.respond({
      userRequest: "ping",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "", memory: null },
      environment: { cwd: "/projects/sample", platform: "win32" },
      tools: {},
      activeTask
    });
    const systemMessage = body.messages.find((m) => m.role === "system");
    assert.ok(systemMessage, "system message should be present");
    assert.match(systemMessage.content, /Working directory: \/projects\/sample/);
    assert.match(systemMessage.content, /Platform: win32/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter adapter sends context-compression plugin by default and honors disable flag", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-compress-"));
  const activeTask = { id: "task-compress", dir: path.join(cwd, ".agent", "tasks", "task-compress") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const bodies = [];
  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      };
    };

    const onAdapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      capabilities: { toolCalling: true }
    });
    await onAdapter.respond({
      userRequest: "ping",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "", memory: null },
      tools: {},
      activeTask
    });
    assert.deepEqual(bodies[0].plugins, [{ id: "context-compression" }]);

    const offAdapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      contextCompression: false,
      maxRetries: 0,
      capabilities: { toolCalling: true }
    });
    await offAdapter.respond({
      userRequest: "ping",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "", memory: null },
      tools: {},
      activeTask
    });
    assert.equal(bodies[1].plugins, undefined, "disabled flag should drop the plugins entry");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenAI adapter does NOT send the OpenRouter context-compression plugin", async () => {
  const { createOpenAIAdapter } = await import("../src/model/openai.js");
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-openai-"));
  const activeTask = { id: "task-oai", dir: path.join(cwd, ".agent", "tasks", "task-oai") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let body = null;
  try {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      };
    };
    const adapter = createOpenAIAdapter({
      provider: "openai",
      model: "gpt-4o-mini",
      apiKeyEnv: "OPENAI_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      capabilities: { toolCalling: true }
    });
    await adapter.respond({
      userRequest: "ping",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "", memory: null },
      tools: {},
      activeTask
    });
    assert.equal(body.plugins, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
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

test("OpenRouter respondJson returns parsed structured JSON and tolerates fenced output", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-respondjson-"));
  const activeTask = { id: "task-respondjson", dir: path.join(cwd, ".agent", "tasks", "task-respondjson") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;

  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    let body;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "```json\n{\"summary\":\"ok\",\"steps\":[\"a\"]}\n```" } }],
          usage: { total_tokens: 8 }
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
      capabilities: { jsonMode: true }
    });

    const result = await adapter.respondJson({
      system: "Return JSON",
      user: { hello: "world" },
      activeTask
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.structured, { summary: "ok", steps: ["a"] });
    assert.equal(body.response_format?.type, "json_object");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("OpenRouter respondJson reports failure when the model returns non-JSON", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;

  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "I am not JSON, friend." } }]
      })
    });

    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: "json/model",
      apiKeyEnv: "OPENROUTER_API_KEY",
      allowNetwork: true,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      capabilities: { jsonMode: true }
    });

    const result = await adapter.respondJson({ system: "x", user: "x" });
    assert.equal(result.ok, false);
    assert.match(result.message, /not valid JSON/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
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
