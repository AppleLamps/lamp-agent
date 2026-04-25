import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask } from "../src/task/task-manager.js";
import { updateBeliefsFromResponse } from "../src/task/beliefs.js";
import { finalReview } from "../src/review/review.js";

test("finalReview renders a plain-English review card", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
    const activeTask = await createTask(cwd, "Explain project");
    await updateBeliefsFromResponse(activeTask, {
      taskPatch: { assumptions: ["Network model calls are disabled."] }
    });

    const review = await finalReview(activeTask, tools(), {
      message: "Done.",
      taskPatch: { assumptions: ["Network model calls are disabled."] }
    }, {
      summary: "Local critique found no obvious issues.",
      findings: [],
      status: "reviewed"
    });

    assert.match(review, /^Done\./);
    assert.match(review, /Changed:/);
    assert.match(review, /Warnings:/);
    assert.match(review, /Next actions:/);

    const finalSummary = await readFile(path.join(activeTask.dir, "final-summary.md"), "utf8");
    assert.match(finalSummary, /beliefs\.json/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function tools() {
  return {
    runAvailableChecks: async () => [{ name: "checks", skipped: true, message: "No scripts." }],
    taskDiff: async () => ({ ok: true, source: "snapshots", summary: [] })
  };
}
