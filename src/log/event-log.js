import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function appendEvent(taskDir, event) {
  await mkdir(taskDir, { recursive: true });
  const entry = {
    ...event,
    timestamp: new Date().toISOString()
  };
  await appendFile(path.join(taskDir, "events.jsonl"), `${JSON.stringify(entry)}\n`);
}
