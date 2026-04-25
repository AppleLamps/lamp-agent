import test from "node:test";
import assert from "node:assert/strict";
import { createInteractivePrompts } from "../src/ui/interactive.js";

test("interactive prompts report unhandled when not in a TTY", async () => {
  const prompts = createInteractivePrompts({
    input: { isTTY: false },
    output: { isTTY: false }
  });

  assert.equal(prompts.interactive, false);
  assert.deepEqual(await prompts.approval({ message: "Allow?" }), { handled: false });
  assert.deepEqual(await prompts.reviewAction(), { handled: false });
  assert.deepEqual(await prompts.conflictResolution({ path: "example.txt" }), { handled: false });
});
