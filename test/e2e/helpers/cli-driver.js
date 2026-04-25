import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "src", "index.js");

const DEFAULT_EXPECT_TIMEOUT_MS = 30000;
const DEFAULT_EXIT_TIMEOUT_MS = 15000;

export function spawnCli({ cwd, env = {} } = {}) {
  if (!cwd) throw new Error("spawnCli requires a cwd.");
  // Strip env vars that mark the current process as running inside Node's
  // test runner. Without this, any `node --test` invocation the CLI makes
  // (for example, via `npm test` in a fixture) would attach to the parent
  // test runner via the v8 child-test protocol and report exit code 0 on
  // failure, masking real check failures.
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) {
    if (key === "NODE_TEST_CONTEXT" || key.startsWith("NODE_TEST_")) {
      delete baseEnv[key];
    }
  }
  const child = spawn(process.execPath, [CLI_PATH], {
    cwd,
    env: { ...baseEnv, NO_COLOR: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  const stdoutListeners = new Set();
  let exited = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (const listener of stdoutListeners) listener(stdout);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => { /* ignore EPIPE on closed child */ });

  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  const driver = {
    child,
    cwd,

    stdout: () => stdout,
    stderr: () => stderr,

    async expect(matcher, { timeout = DEFAULT_EXPECT_TIMEOUT_MS } = {}) {
      const re = matcher instanceof RegExp ? matcher : new RegExp(escapeRegex(matcher));
      const initial = re.exec(stdout);
      if (initial) return { match: initial[0], stdout };
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stdoutListeners.delete(listener);
          child.removeListener("exit", onExit);
          fn(value);
        };
        const timer = setTimeout(() => {
          finish(reject, new Error(
            `Timed out after ${timeout}ms waiting for ${re.source}\n` +
            `--- stdout (${stdout.length} chars) ---\n${stdout}\n` +
            `--- stderr (${stderr.length} chars) ---\n${stderr}`
          ));
        }, timeout);
        const listener = (current) => {
          const found = re.exec(current);
          if (!found) return;
          finish(resolve, { match: found[0], stdout: current });
        };
        const onExit = (code, signal) => {
          // Fall through to a final stdout check first so we don't miss
          // a regex that landed in the same tick as the process exit.
          if (re.exec(stdout)) {
            finish(resolve, { match: re.exec(stdout)[0], stdout });
            return;
          }
          finish(reject, new Error(
            `Child process exited (code=${code}, signal=${signal}) before matching ${re.source}\n` +
            `--- stdout (${stdout.length} chars) ---\n${stdout}\n` +
            `--- stderr (${stderr.length} chars) ---\n${stderr}`
          ));
        };
        stdoutListeners.add(listener);
        child.on("exit", onExit);
        if (exited) onExit(child.exitCode, child.signalCode);
      });
    },

    async sendLine(line) {
      if (exited) throw new Error("CLI has already exited; cannot sendLine.");
      await new Promise((resolve, reject) => {
        child.stdin.write(`${line}\n`, (err) => err ? reject(err) : resolve());
      });
    },

    /**
     * Wait for the typed-fallback "approval > " prompt the harness writes
     * when an approval boundary is hit and the inquirer prompts are
     * unavailable (non-TTY stdin), then send a single-line answer such
     * as `yes`, `no`, `cancel`, or `alternative`.
     */
    async respondToApproval(answer, opts = {}) {
      await this.expect(/approval > $/, opts);
      await this.sendLine(answer);
    },

    async exit({ timeout = DEFAULT_EXIT_TIMEOUT_MS } = {}) {
      if (!exited) {
        try {
          if (!child.stdin.writableEnded) child.stdin.end();
        } catch {
          /* ignore */
        }
      }
      const timeoutToken = Symbol("timeout");
      const result = await Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(() => resolve(timeoutToken), timeout))
      ]);
      if (result === timeoutToken) {
        child.kill();
        throw new Error(
          `CLI did not exit within ${timeout}ms.\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
        );
      }
      return result;
    },

    waitForExit() {
      return exitPromise;
    },

    kill(signal) {
      if (!exited) {
        try { child.kill(signal); } catch { /* ignore */ }
      }
    }
  };

  return driver;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
