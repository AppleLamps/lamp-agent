import test from "node:test";
import assert from "node:assert/strict";
import { box, createTerminalUi, stripAnsi } from "../src/ui/terminal.js";

test("box renders an ASCII bordered card", () => {
  const rendered = box("review", "Changed:\n- app.js", { color: false });
  assert.match(rendered, /^\+-- review -+\+/);
  assert.match(rendered, /\| Changed:/);
  assert.match(rendered, /\| - app\.js/);
});

test("terminal ui renders plain prompt without tty color", () => {
  const output = { isTTY: false };
  const ui = createTerminalUi({ output, env: {} });
  assert.equal(ui.prompt(), "agent > ");
  assert.equal(stripAnsi(ui.banner("0.1.0")).includes("Lamp Agent 0.1.0"), true);
});

test("stripAnsi removes color sequences", () => {
  assert.equal(stripAnsi("\x1b[32mok\x1b[0m"), "ok");
});

test("banner renders provider/model status when given", () => {
  const ui = createTerminalUi({ output: { isTTY: false }, env: {} });
  const text = stripAnsi(ui.banner("0.1.0", {
    provider: "openrouter",
    model: "anthropic/claude-3-5-sonnet",
    allowNetwork: true,
    apiKeyConfigured: true,
    streaming: true,
    promptCaching: true,
    reasoning: false
  }));
  assert.match(text, /openrouter · anthropic\/claude-3-5-sonnet/);
  assert.match(text, /streaming, prompt-cached/);
});

test("banner warns when no API key is configured", () => {
  const ui = createTerminalUi({ output: { isTTY: false }, env: {} });
  const text = stripAnsi(ui.banner("0.1.0", {
    provider: "openrouter",
    model: "anthropic/claude-3-5-sonnet",
    allowNetwork: true,
    apiKeyConfigured: false
  }));
  assert.match(text, /no API key/);
});

test("banner warns when network is disabled", () => {
  const ui = createTerminalUi({ output: { isTTY: false }, env: {} });
  const text = stripAnsi(ui.banner("0.1.0", {
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    allowNetwork: false,
    apiKeyConfigured: true
  }));
  assert.match(text, /network disabled/);
});

test("banner copy says \"agent\" not \"harness\"", () => {
  const ui = createTerminalUi({ output: { isTTY: false }, env: {} });
  const text = stripAnsi(ui.banner("0.1.0"));
  assert.match(text, /Plain-English coding agent/);
  assert.equal(/harness/i.test(text), false);
});
