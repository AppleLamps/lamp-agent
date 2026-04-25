import test from "node:test";
import assert from "node:assert/strict";
import { add, multiply } from "../src/math.js";

test("add returns the sum of two numbers", () => {
  assert.equal(add(1, 2), 3);
  assert.equal(add(-3, 3), 0);
});

test("multiply returns the product of two numbers", () => {
  assert.equal(multiply(2, 3), 6);
  assert.equal(multiply(0, 7), 0);
});
