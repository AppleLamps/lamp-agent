import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTask } from "../src/task/task-manager.js";
import {
  summarizeBeliefs,
  updateBeliefsFromCritique,
  updateBeliefsFromResponse,
  updateBeliefsFromTriage
} from "../src/task/beliefs.js";

test("belief ledger records triage, response assumptions, decisions, and critique findings", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "lamp-agent-"));
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    const activeTask = await createTask(cwd, "Add settings");

    await updateBeliefsFromTriage(activeTask, {
      fileCount: 1,
      packageManager: "npm",
      scripts: ["test"]
    });
    await updateBeliefsFromResponse(activeTask, {
      taskPatch: {
        assumptions: ["No storage provider was found."],
        current_plan: ["Inspect files", "Patch route"]
      }
    });
    await updateBeliefsFromCritique(activeTask, {
      source: "local",
      summary: "Review completed.",
      findings: [{ severity: "error", text: "A check failed." }]
    });

    const beliefs = await summarizeBeliefs(activeTask);
    assert.equal(beliefs.assumptions.some((claim) => claim.text === "No storage provider was found."), true);
    assert.equal(beliefs.risks.some((claim) => claim.text === "A check failed."), true);
    assert.equal(beliefs.decisions.length >= 2, true);

    const raw = await readFile(path.join(activeTask.dir, "beliefs.json"), "utf8");
    assert.match(raw, /The detected package manager is npm/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
