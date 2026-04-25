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
