import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCheckpoint } from "../workspace/checkpoint.js";

export async function createTask(cwd, userRequest) {
  const now = new Date();
  const id = `task-${formatTimestamp(now)}`;
  const dir = path.join(cwd, ".agent", "tasks", id);
  await mkdir(dir, { recursive: true });
  const checkpoint = await createCheckpoint(cwd, id);

  const task = {
    id,
    user_request: userRequest,
    task_type: classifyTask(userRequest),
    status: "intake",
    goal: userRequest,
    constraints: [],
    assumptions: [],
    definition_of_done: defaultDefinitionOfDone(userRequest),
    open_questions: [],
    current_plan: [],
    changed_files: [],
    checkpoint_id: checkpoint.id,
    checkpoint_path: path.relative(cwd, checkpoint.path).replaceAll("\\", "/"),
    risk_level: "normal",
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };

  const beliefs = {
    claims: [
      {
        id: "claim-1",
        text: "The user request has not yet been verified against project files.",
        type: "hypothesis",
        confidence: 0.5,
        status: "unverified",
        evidence: [],
        created_at: now.toISOString()
      }
    ],
    decisions: []
  };

  await writeJson(path.join(dir, "task.json"), task);
  await writeJson(path.join(dir, "beliefs.json"), beliefs);
  await writeJson(path.join(dir, "changed-files.json"), []);
  await writeFile(path.join(dir, "commands.jsonl"), "");
  return { id, dir, task };
}

export async function loadTask(cwd, taskId) {
  const dir = path.join(cwd, ".agent", "tasks", taskId);
  const task = JSON.parse(await readFile(path.join(dir, "task.json"), "utf8"));
  return { id: task.id || taskId, dir, task };
}

export async function updateTaskStatus(activeTask, status, patch = {}) {
  const taskPath = path.join(activeTask.dir, "task.json");
  const task = JSON.parse(await readFile(taskPath, "utf8"));
  const updated = {
    ...task,
    ...patch,
    status,
    updated_at: new Date().toISOString()
  };
  await writeJson(taskPath, updated);
  activeTask.task = updated;
  return updated;
}

function classifyTask(text) {
  const lower = text.toLowerCase();
  if (/\b(why|explain|where|what kind|how does)\b/.test(lower)) return "explain";
  if (/\b(fix|bug|failing|broken|error)\b/.test(lower)) return "fix";
  if (/\b(refactor|cleanup|clean up)\b/.test(lower)) return "refactor";
  if (/\b(add|create|build|implement)\b/.test(lower)) return "build";
  return "change";
}

function defaultDefinitionOfDone(userRequest) {
  return [
    "Relevant project files have been inspected",
    "The response is based on actual workspace evidence",
    "Any changed files are tracked",
    "Appropriate local checks are run or skipped with a reason",
    `The user request is addressed: ${userRequest}`
  ];
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
