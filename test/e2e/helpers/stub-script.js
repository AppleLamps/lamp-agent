// Test-side helper for the stub model adapter.
//
// The stub adapter itself lives in `stub-adapter.js` and is loaded by the
// spawned CLI process. This module is loaded by the test process and
// provides:
//
//  - STUB_ADAPTER_PATH: absolute path to stub-adapter.js, suitable for
//    setting LAMP_MODEL_ADAPTER on the spawned CLI.
//  - writeStubScript(script): write a script JSON to a tmp file and
//    return both the file path and a cleanup function. Tests pass the
//    path through LAMP_STUB_SCRIPT.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const STUB_ADAPTER_PATH = path.join(HERE, "stub-adapter.js");

export async function writeStubScript(script) {
  const dir = await mkdtemp(path.join(tmpdir(), "lamp-stub-"));
  const file = path.join(dir, "script.json");
  await writeFile(file, JSON.stringify(script, null, 2));
  return {
    path: file,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
