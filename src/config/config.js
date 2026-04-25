import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG = {
  mode: "fast-safe",
  ui_mode: "builder",
  permissions: {
    allowLocalEdits: true,
    allowLocalChecks: true,
    askForNetwork: true,
    askForDependencies: true,
    askForSecrets: true,
    askForOutsideWorkspace: true,
    askForPushDeploy: true
  },
  model: {
    provider: "openrouter",
    model: process.env.OPENROUTER_MODEL || "anthropic/claude-3.5-sonnet",
    apiKeyEnv: "OPENROUTER_API_KEY",
    allowNetwork: false
  },
  workspace: {
    shadowMode: "off"
  }
};

export async function loadConfig(cwd) {
  const agentDir = path.join(cwd, ".agent");
  const configPath = path.join(agentDir, "config.json");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(agentDir, "tasks"), { recursive: true });
  await mkdir(path.join(agentDir, "checkpoints"), { recursive: true });
  await mkdir(path.join(agentDir, "patches"), { recursive: true });
  await mkdir(path.join(agentDir, "logs"), { recursive: true });
  await mkdir(path.join(agentDir, "memory"), { recursive: true });

  try {
    const existing = JSON.parse(await readFile(configPath, "utf8"));
    return mergeConfig(DEFAULT_CONFIG, existing);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return DEFAULT_CONFIG;
  }
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    permissions: { ...base.permissions, ...override.permissions },
    model: { ...base.model, ...override.model },
    workspace: { ...base.workspace, ...override.workspace }
  };
}
