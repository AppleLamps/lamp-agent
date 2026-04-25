import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.resolve(HERE, "..", "..", "fixtures");

export async function copyFixture(name) {
  const source = path.join(FIXTURES_ROOT, name);
  const dest = await mkdtemp(path.join(tmpdir(), `lamp-e2e-${name}-`));
  await cp(source, dest, { recursive: true, force: true });
  return {
    cwd: dest,
    source,
    async cleanup() {
      await rm(dest, { recursive: true, force: true });
    }
  };
}
