import test from "node:test";
import assert from "node:assert/strict";
import { brokenAdd } from "../src/calculator.js";

test("brokenAdd returns the correct sum", () => {
  // Deliberately fails: brokenAdd is intentionally off by one.
  assert.equal(brokenAdd(2, 3), 5);
});
