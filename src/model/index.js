import path from "node:path";
import { pathToFileURL } from "node:url";
import { createOpenRouterAdapter } from "./openrouter.js";
import { createOpenAIAdapter } from "./openai.js";
import { createLocalAdapter } from "./local.js";
import { createAnthropicAdapter } from "./anthropic.js";

export { createOpenRouterAdapter } from "./openrouter.js";
export { createOpenAIAdapter } from "./openai.js";
export { createLocalAdapter } from "./local.js";
export { createAnthropicAdapter } from "./anthropic.js";
export {
  MODEL_ADAPTER_METHODS,
  DEFAULT_MODEL_CAPABILITIES,
  assertModelAdapter,
  normalizeModelCapabilities
} from "./adapter-contract.js";

/**
 * Build a model adapter for the given model config.
 *
 * Dispatch order:
 *   1. `LAMP_MODEL_ADAPTER` env var (test stub injection): a filesystem
 *      path to an ESM module that exports
 *      `createAdapter(modelConfig) -> adapter | Promise<adapter>`. Used
 *      by the end-to-end test suite. Absolute paths used as-is;
 *      relative paths resolved against the harness's cwd.
 *   2. `modelConfig.provider`:
 *        - `"openrouter"` (default) → `createOpenRouterAdapter`
 *        - `"openai"`               → `createOpenAIAdapter`
 *        - `"anthropic"`            → `createAnthropicAdapter`
 *        - `"local"`                → `createLocalAdapter`
 *
 * Per-provider env vars (defaults; configurable via
 * `model.apiKeyEnv` in `.agent/config.json`):
 *   - openrouter: OPENROUTER_API_KEY
 *   - openai:     OPENAI_API_KEY
 *   - anthropic:  ANTHROPIC_API_KEY
 *   - local:      LAMP_LOCAL_API_KEY (any non-empty string for Ollama
 *                 / LM Studio; many local servers ignore it entirely)
 */
export async function createModelAdapter(modelConfig = {}) {
  const override = process.env.LAMP_MODEL_ADAPTER;
  if (override) {
    const absolute = path.isAbsolute(override)
      ? override
      : path.resolve(process.cwd(), override);
    const module = await import(pathToFileURL(absolute).href);
    if (typeof module.createAdapter !== "function") {
      throw new Error(
        `LAMP_MODEL_ADAPTER (${override}) must export an async createAdapter(modelConfig) function.`
      );
    }
    return await module.createAdapter(modelConfig);
  }
  switch (modelConfig.provider) {
    case "openai": return createOpenAIAdapter(modelConfig);
    case "anthropic": return createAnthropicAdapter(modelConfig);
    case "local": return createLocalAdapter(modelConfig);
    case "openrouter":
    case undefined:
    case null:
      return createOpenRouterAdapter(modelConfig);
    default:
      throw new Error(
        `Unknown model provider: ${modelConfig.provider}. ` +
        `Supported providers: openrouter, openai, anthropic, local.`
      );
  }
}
