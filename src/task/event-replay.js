// Replay helpers for /resume. The phase artifacts under
// `.agent/tasks/<id>/` already record everything the harness did;
// these helpers extract a small, model-friendly slice of that history
// so a resumed task can hand the model the conversation it had before
// being interrupted.
//
// Tool calls and tool results are intentionally NOT replayed: their
// tool_call_ids don't round-trip across processes and stitching them
// back together is fragile. Plain assistant text is enough to give the
// model conversational continuity.

import { readFile } from "node:fs/promises";
import path from "node:path";

async function readJsonLines(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read `events.jsonl` for the task and return up to `maxTurns` of
 * the most recent assistant_response messages, capped by `maxChars`
 * total characters (oldest dropped first when over budget).
 *
 * @param {{dir: string}} activeTask
 * @param {{maxTurns?: number, maxChars?: number}} [options]
 * @returns {Promise<string[]>}
 */
export async function collectPriorAssistantTurns(activeTask, { maxTurns = 3, maxChars = 8000 } = {}) {
  if (!activeTask?.dir) return [];
  const events = await readJsonLines(path.join(activeTask.dir, "events.jsonl"));
  const turns = [];
  for (const event of events) {
    if (event?.type === "assistant_response" && typeof event.message === "string" && event.message.trim()) {
      turns.push(event.message.trim());
    }
  }
  const tail = turns.slice(-maxTurns);
  let total = 0;
  const out = [];
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (total + tail[i].length > maxChars) break;
    out.unshift(tail[i]);
    total += tail[i].length;
  }
  return out;
}
