import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectPriorAssistantTurns } from "../src/task/event-replay.js";

async function makeTask(events) {
  const root = await mkdtemp(path.join(tmpdir(), "replay-"));
  const dir = path.join(root, ".agent", "tasks", "T1");
  await mkdir(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(path.join(dir, "events.jsonl"), lines + "\n");
  return { root, dir };
}

test("returns last N assistant_response messages in chronological order", async () => {
  const { root, dir } = await makeTask([
    { type: "task_started", message: "go" },
    { type: "assistant_response", message: "first" },
    { type: "tool_call", message: "noise" },
    { type: "assistant_response", message: "second" },
    { type: "assistant_response", message: "third" },
    { type: "assistant_response", message: "fourth" }
  ]);
  try {
    const turns = await collectPriorAssistantTurns({ dir }, { maxTurns: 3 });
    assert.deepEqual(turns, ["second", "third", "fourth"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("respects maxChars budget by dropping oldest entries first", async () => {
  const { root, dir } = await makeTask([
    { type: "assistant_response", message: "A".repeat(50) },
    { type: "assistant_response", message: "B".repeat(50) },
    { type: "assistant_response", message: "C".repeat(50) }
  ]);
  try {
    // Budget for 2 entries (50+50 = 100 fits, adding 50 more = 150 exceeds).
    const turns = await collectPriorAssistantTurns({ dir }, { maxTurns: 5, maxChars: 120 });
    assert.equal(turns.length, 2);
    assert.equal(turns[0], "B".repeat(50));
    assert.equal(turns[1], "C".repeat(50));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns empty array when events.jsonl is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "replay-empty-"));
  const dir = path.join(root, ".agent", "tasks", "T1");
  await mkdir(dir, { recursive: true });
  try {
    const turns = await collectPriorAssistantTurns({ dir });
    assert.deepEqual(turns, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores blank or whitespace-only assistant messages", async () => {
  const { root, dir } = await makeTask([
    { type: "assistant_response", message: "real" },
    { type: "assistant_response", message: "   " },
    { type: "assistant_response", message: "" }
  ]);
  try {
    const turns = await collectPriorAssistantTurns({ dir }, { maxTurns: 5 });
    assert.deepEqual(turns, ["real"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tolerates malformed JSON lines mixed in events.jsonl", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "replay-mal-"));
  const dir = path.join(root, ".agent", "tasks", "T1");
  await mkdir(dir, { recursive: true });
  const text = [
    JSON.stringify({ type: "assistant_response", message: "good 1" }),
    "not-json-{",
    JSON.stringify({ type: "assistant_response", message: "good 2" }),
    ""
  ].join("\n");
  await writeFile(path.join(dir, "events.jsonl"), text);
  try {
    const turns = await collectPriorAssistantTurns({ dir });
    assert.deepEqual(turns, ["good 1", "good 2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns empty array when activeTask has no dir", async () => {
  assert.deepEqual(await collectPriorAssistantTurns(null), []);
  assert.deepEqual(await collectPriorAssistantTurns({}), []);
});
