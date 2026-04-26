import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createModelAdapter,
  createOpenAIAdapter,
  createLocalAdapter,
  createAnthropicAdapter
} from "../src/model/index.js";
import { assertModelAdapter, MODEL_ADAPTER_METHODS } from "../src/model/adapter-contract.js";

test("createModelAdapter dispatches by provider", async () => {
  // OpenRouter (default).
  const openrouter = await createModelAdapter({});
  assert.equal(openrouter.capabilities().provider, "openrouter");

  // OpenAI.
  const openai = await createModelAdapter({ provider: "openai" });
  assert.equal(openai.capabilities().provider, "openai");

  // Anthropic.
  const anthropic = await createModelAdapter({ provider: "anthropic" });
  assert.equal(anthropic.capabilities().provider, "anthropic");

  // Local — requires endpoint.
  const local = await createModelAdapter({ provider: "local", endpoint: "http://localhost:11434/v1/chat/completions" });
  assert.equal(local.capabilities().provider, "local");

  // Unknown provider rejects.
  await assert.rejects(
    () => createModelAdapter({ provider: "magicllm" }),
    /Unknown model provider: magicllm/
  );
});

test("each new adapter satisfies the model-adapter contract", () => {
  for (const adapter of [
    createOpenAIAdapter({}),
    createAnthropicAdapter({}),
    createLocalAdapter({ endpoint: "http://localhost:11434/v1/chat/completions" })
  ]) {
    assert.equal(assertModelAdapter(adapter), adapter);
    for (const method of MODEL_ADAPTER_METHODS) {
      assert.equal(typeof adapter[method], "function", `missing ${method}`);
    }
  }
});

test("createLocalAdapter requires an endpoint or baseUrl", () => {
  assert.throws(() => createLocalAdapter({}), /requires modelConfig\.endpoint/);
  assert.throws(() => createLocalAdapter({ provider: "local" }), /requires modelConfig\.endpoint/);
  // Both forms accepted.
  assert.ok(createLocalAdapter({ endpoint: "http://localhost:11434/v1/chat/completions" }));
  assert.ok(createLocalAdapter({ baseUrl: "http://localhost:11434/v1" }));
});

test("OpenAI adapter posts to api.openai.com without OpenRouter referer headers", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-openai-"));
  const activeTask = { id: "task-openai", dir: path.join(cwd, ".agent", "tasks", "task-openai") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let observedUrl = null;
  let observedHeaders = null;

  try {
    process.env.OPENAI_API_KEY = "sk-test";
    globalThis.fetch = async (url, init) => {
      observedUrl = url;
      observedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Hello from OpenAI." } }],
          usage: { total_tokens: 12 }
        })
      };
    };

    const adapter = createOpenAIAdapter({
      model: "gpt-4o-mini",
      allowNetwork: true,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      capabilities: { toolCalling: true }
    });

    const response = await adapter.respond({
      userRequest: "say hi",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "" },
      tools: {},
      activeTask
    });

    assert.equal(response.message, "Hello from OpenAI.");
    assert.equal(observedUrl, "https://api.openai.com/v1/chat/completions");
    assert.equal(observedHeaders.Authorization, "Bearer sk-test");
    // Must NOT carry OpenRouter's referer / title header noise.
    assert.equal(observedHeaders["HTTP-Referer"], undefined);
    assert.equal(observedHeaders["X-Title"], undefined);

    const usage = (await readFile(path.join(activeTask.dir, "model-usage.jsonl"), "utf8")).trim();
    assert.match(usage, /"provider":"openai"/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Local adapter posts to the configured baseUrl", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-local-"));
  const activeTask = { id: "task-local", dir: path.join(cwd, ".agent", "tasks", "task-local") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.LAMP_LOCAL_API_KEY;
  let observedUrl = null;

  try {
    process.env.LAMP_LOCAL_API_KEY = "anything";
    globalThis.fetch = async (url) => {
      observedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "From Ollama." } }],
          usage: { total_tokens: 5 }
        })
      };
    };

    const adapter = createLocalAdapter({
      model: "llama3.1",
      baseUrl: "http://localhost:11434/v1",
      allowNetwork: true,
      maxRetries: 0,
      retryBaseDelayMs: 0,
      capabilities: { toolCalling: true }
    });

    const response = await adapter.respond({
      userRequest: "say hi",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "" },
      tools: {},
      activeTask
    });

    assert.equal(response.message, "From Ollama.");
    assert.equal(observedUrl, "http://localhost:11434/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LAMP_LOCAL_API_KEY;
    else process.env.LAMP_LOCAL_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Anthropic adapter translates tool calls and returns the assistant text", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-anthropic-"));
  const activeTask = { id: "task-anthropic", dir: path.join(cwd, ".agent", "tasks", "task-anthropic") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const requestBodies = [];
  const requestHeaders = [];

  try {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    let call = 0;
    globalThis.fetch = async (url, init) => {
      call += 1;
      requestBodies.push(JSON.parse(init.body));
      requestHeaders.push(init.headers);
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      if (call === 1) {
        // First Anthropic response: a tool_use block asking to list files.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [
              { type: "text", text: "Looking up files..." },
              {
                type: "tool_use",
                id: "tu_01",
                name: "list_files",
                input: { path: "." }
              }
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 50, output_tokens: 12 }
          })
        };
      }
      // Second response: final answer with no more tool_use blocks.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "All set." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 30, output_tokens: 4 }
        })
      };
    };

    const tools = {
      listFiles: async () => ({ ok: true, files: ["a.js", "b.js"] })
    };

    const adapter = createAnthropicAdapter({
      model: "claude-3-5-sonnet-20241022",
      allowNetwork: true,
      capabilities: { toolCalling: true }
    });

    const response = await adapter.respond({
      userRequest: "list files",
      projectSummary: { fileCount: 2, scripts: [], notableFiles: ["a.js"], git: "" },
      tools,
      activeTask
    });

    assert.equal(response.message, "All set.");
    // Authentication uses x-api-key plus anthropic-version header.
    assert.equal(requestHeaders[0]["x-api-key"], "sk-ant-test");
    assert.equal(requestHeaders[0]["anthropic-version"], "2023-06-01");
    // Tools translated from OpenAI format into Anthropic input_schema.
    const firstToolDef = (requestBodies[0].tools || []).find((tool) => tool.name === "list_files");
    assert.ok(firstToolDef, "list_files tool should be present in the request");
    assert.ok(firstToolDef.input_schema, "tool should carry an input_schema");
    // Second request includes a tool_result block from the harness.
    const secondMessages = requestBodies[1].messages;
    const toolResultMessage = secondMessages.find((message) =>
      Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result")
    );
    assert.ok(toolResultMessage, "second request must include a tool_result block");

    // Usage tracked under model-usage.jsonl with provider:anthropic.
    const usage = (await readFile(path.join(activeTask.dir, "model-usage.jsonl"), "utf8")).trim();
    assert.match(usage, /"provider":"anthropic"/);
    assert.match(usage, /"prompt_tokens":50/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Anthropic adapter sends prompt-caching beta header and cache_control on system when promptCaching is enabled", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-anthropic-cache-"));
  const activeTask = { id: "task-anthropic-cache", dir: path.join(cwd, ".agent", "tasks", "task-anthropic-cache") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  let requestBody = null;
  let requestHeaders = null;
  try {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      requestHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "Cached." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2 }
        })
      };
    };

    const adapter = createAnthropicAdapter({
      model: "claude-3-5-sonnet-20241022",
      allowNetwork: true,
      promptCaching: true
    });
    const response = await adapter.respond({
      userRequest: "ping",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "" },
      tools: {},
      activeTask
    });
    assert.equal(response.message, "Cached.");
    assert.equal(requestHeaders["anthropic-beta"], "prompt-caching-2024-07-31");
    // System prompt is sent as a structured array with cache_control on the
    // static block so subsequent calls hit the cache.
    assert.ok(Array.isArray(requestBody.system), "system should be sent as an array of blocks when caching");
    assert.equal(requestBody.system[0].type, "text");
    assert.deepEqual(requestBody.system[0].cache_control, { type: "ephemeral" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Anthropic adapter sends a plain string system prompt when promptCaching is off (default)", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-anthropic-nocache-"));
  const activeTask = { id: "t", dir: path.join(cwd, ".agent", "tasks", "t") };
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  let requestBody = null;
  let requestHeaders = null;
  try {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      requestHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 1 }
        })
      };
    };
    const adapter = createAnthropicAdapter({
      model: "claude-3-5-sonnet-20241022",
      allowNetwork: true
    });
    await adapter.respond({
      userRequest: "ping",
      projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "" },
      tools: {},
      activeTask
    });
    assert.equal(typeof requestBody.system, "string");
    assert.equal(requestHeaders["anthropic-beta"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Anthropic adapter falls back to a local message when the network is disabled", async () => {
  const adapter = createAnthropicAdapter({
    model: "claude-3-5-sonnet-20241022",
    allowNetwork: false
  });
  const response = await adapter.respond({
    userRequest: "explain",
    projectSummary: { fileCount: 0, scripts: [], notableFiles: [], git: "" },
    tools: {},
    activeTask: null
  });
  assert.match(response.message, /Anthropic|local harness/i);
});
