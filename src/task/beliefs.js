import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function addClaim(activeTask, claim) {
  const beliefs = await readBeliefs(activeTask);
  const nextId = `claim-${beliefs.claims.length + 1}`;
  beliefs.claims.push({
    id: claim.id || nextId,
    text: claim.text,
    type: claim.type || "fact",
    confidence: claim.confidence ?? 0.8,
    status: claim.status || "supported",
    evidence: claim.evidence || [],
    created_at: new Date().toISOString()
  });
  await writeBeliefs(activeTask, beliefs);
  return beliefs;
}

export async function addDecision(activeTask, decision) {
  const beliefs = await readBeliefs(activeTask);
  const nextId = `decision-${beliefs.decisions.length + 1}`;
  beliefs.decisions.push({
    id: decision.id || nextId,
    text: decision.text,
    reason: decision.reason,
    created_at: new Date().toISOString()
  });
  await writeBeliefs(activeTask, beliefs);
  return beliefs;
}

export async function updateBeliefsFromTriage(activeTask, projectSummary) {
  await addClaim(activeTask, {
    text: `The workspace contains ${projectSummary.fileCount} file(s) visible to the harness.`,
    type: "fact",
    confidence: 1,
    status: "confirmed",
    evidence: ["project_summary.fileCount"]
  });

  await addClaim(activeTask, {
    text: projectSummary.packageManager
      ? `The detected package manager is ${projectSummary.packageManager}.`
      : "No package manager was detected.",
    type: "fact",
    confidence: 1,
    status: "confirmed",
    evidence: ["project_summary.packageManager"]
  });

  if (projectSummary.scripts.length) {
    await addClaim(activeTask, {
      text: `Available package scripts include: ${projectSummary.scripts.join(", ")}.`,
      type: "fact",
      confidence: 1,
      status: "confirmed",
      evidence: ["package.json scripts"]
    });
  }
}

export async function updateBeliefsFromResponse(activeTask, response) {
  const assumptions = response.taskPatch?.assumptions || [];
  for (const assumption of assumptions) {
    await addClaim(activeTask, {
      text: assumption,
      type: "assumption",
      confidence: 0.6,
      status: "unverified",
      evidence: ["assistant_response.taskPatch.assumptions"]
    });
  }

  const plan = response.taskPatch?.current_plan || [];
  if (plan.length) {
    await addDecision(activeTask, {
      text: `Use current plan: ${plan.join(" -> ")}.`,
      reason: "Plan generated for this task after project triage."
    });
  }
}

export async function updateBeliefsFromCritique(activeTask, critique) {
  for (const finding of critique.findings || []) {
    await addClaim(activeTask, {
      text: finding.text,
      type: finding.severity === "error" ? "risk" : "hypothesis",
      confidence: finding.severity === "info" ? 0.6 : 0.8,
      status: finding.severity === "error" ? "supported" : "unverified",
      evidence: ["review.md"]
    });
  }

  await addDecision(activeTask, {
    text: `Run ${critique.source} critique before final review.`,
    reason: critique.summary
  });
}

export async function summarizeBeliefs(activeTask) {
  const beliefs = await readBeliefs(activeTask);
  return {
    claims: beliefs.claims || [],
    decisions: beliefs.decisions || [],
    risks: (beliefs.claims || []).filter((claim) => claim.type === "risk"),
    assumptions: (beliefs.claims || []).filter((claim) => claim.type === "assumption")
  };
}

async function readBeliefs(activeTask) {
  const beliefsPath = path.join(activeTask.dir, "beliefs.json");
  try {
    const beliefs = JSON.parse(await readFile(beliefsPath, "utf8"));
    return {
      claims: beliefs.claims || [],
      decisions: beliefs.decisions || []
    };
  } catch {
    return { claims: [], decisions: [] };
  }
}

async function writeBeliefs(activeTask, beliefs) {
  await writeFile(path.join(activeTask.dir, "beliefs.json"), `${JSON.stringify(beliefs, null, 2)}\n`);
}
