import path from "node:path";
import { pathToFileURL } from "node:url";
import { createOpenRouterAdapter } from "./openrouter.js";

export { createOpenRouterAdapter } from "./openrouter.js";
export {
  MODEL_ADAPTER_METHODS,
  DEFAULT_MODEL_CAPABILITIES,
  assertModelAdapter,
  normalizeModelCapabilities
} from "./adapter-contract.js";

/**
 * Build a model adapter for the given model config.
 *
 * If `LAMP_MODEL_ADAPTER` is set in the environment, it is treated as a
 * filesystem path to an ESM module that exports
 * `createAdapter(modelConfig) -> adapter | Promise<adapter>`. The override
 * is used as-is when absolute, otherwise resolved against the harness's
 * current working directory. This indirection is used by the end-to-end
 * test suite to inject a scripted stub adapter without touching production
 * code paths, and is also where Phase 3 item 5 will hang Anthropic / OpenAI
 * / local-provider implementations.
 *
 * Otherwise the OpenRouter adapter is returned.
 */
export async function createModelAdapter(modelConfig) {
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
  return createOpenRouterAdapter(modelConfig);
}
