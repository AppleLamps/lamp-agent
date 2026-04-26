// Live-network smoke tests for each provider adapter.
//
// These tests are skipped by default. To run them, set
// `LAMP_LIVE_NETWORK_SMOKE=1` and provide whichever provider API
// keys you want to exercise (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`,
// `ANTHROPIC_API_KEY`). Each provider is independently gated so a
// missing key for one provider only skips that one provider.
//
// The tests run a single tiny round-trip to the provider's
// `streamText` method (text-only) and assert that real text comes
// back. They intentionally do not exercise tool calling because that
// requires a richer harness setup — `streamText` is enough to prove
// the auth, headers, and SSE-decoding paths work end to end.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenRouterAdapter } from "../src/model/openrouter.js";
import { createOpenAIAdapter } from "../src/model/openai.js";
import { createAnthropicAdapter } from "../src/model/anthropic.js";

const SMOKE_ENABLED = process.env.LAMP_LIVE_NETWORK_SMOKE === "1";

async function ephemeralTask() {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-smoke-"));
  return {
    cwd,
    activeTask: { id: "smoke", dir: path.join(cwd, ".agent", "tasks", "smoke") },
    cleanup: () => rm(cwd, { recursive: true, force: true })
  };
}

async function runStreamText(adapter, activeTask) {
  let collected = "";
  const result = await adapter.streamText({
    messages: [{ role: "user", content: "Reply with the single word: pong." }],
    onToken: (token) => { collected += token; },
    activeTask,
    purpose: "smoke"
  });
  return { result, collected };
}

test("OpenRouter live smoke", { skip: !SMOKE_ENABLED || !process.env.OPENROUTER_API_KEY }, async () => {
  const { cwd, activeTask, cleanup } = await ephemeralTask();
  try {
    const adapter = createOpenRouterAdapter({
      provider: "openrouter",
      model: process.env.LAMP_SMOKE_OPENROUTER_MODEL || "openrouter/auto",
      allowNetwork: true,
      apiKeyEnv: "OPENROUTER_API_KEY",
      capabilities: { streaming: true }
    });
    const { result, collected } = await runStreamText(adapter, activeTask);
    assert.equal(result.ok, true, result.message);
    assert.ok(collected.length > 0 || result.message, "expected non-empty stream output");
  } finally {
    await cleanup();
    void cwd;
  }
});

test("OpenAI live smoke", { skip: !SMOKE_ENABLED || !process.env.OPENAI_API_KEY }, async () => {
  const { cwd, activeTask, cleanup } = await ephemeralTask();
  try {
    const adapter = createOpenAIAdapter({
      provider: "openai",
      model: process.env.LAMP_SMOKE_OPENAI_MODEL || "gpt-4o-mini",
      allowNetwork: true,
      apiKeyEnv: "OPENAI_API_KEY",
      capabilities: { streaming: true }
    });
    const { result, collected } = await runStreamText(adapter, activeTask);
    assert.equal(result.ok, true, result.message);
    assert.ok(collected.length > 0 || result.message, "expected non-empty stream output");
  } finally {
    await cleanup();
    void cwd;
  }
});

test("Anthropic live smoke", { skip: !SMOKE_ENABLED || !process.env.ANTHROPIC_API_KEY }, async () => {
  const { cwd, activeTask, cleanup } = await ephemeralTask();
  try {
    const adapter = createAnthropicAdapter({
      provider: "anthropic",
      model: process.env.LAMP_SMOKE_ANTHROPIC_MODEL || "claude-3-5-haiku-20241022",
      allowNetwork: true,
      apiKeyEnv: "ANTHROPIC_API_KEY"
    });
    const { result, collected } = await runStreamText(adapter, activeTask);
    assert.equal(result.ok, true, result.message);
    assert.ok(collected.length > 0 || result.message, "expected non-empty stream output");
  } finally {
    await cleanup();
    void cwd;
  }
});
