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
