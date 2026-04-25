// OpenAI adapter.
//
// Thin wrapper around the OpenAI-compatible adapter exported by
// `openrouter.js` (which is OpenAI-format-native and configurable via
// `endpoint` + `extraHeaders` on the model config). The wrapper only
// supplies OpenAI-specific defaults so existing call sites can opt in
// by setting `provider: "openai"` in `.agent/config.json` without
// touching any other field.
import { createOpenRouterAdapter } from "./openrouter.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

/**
 * Create a model adapter that talks to OpenAI's Chat Completions API.
 *
 * Required env: `apiKeyEnv` (defaults to `OPENAI_API_KEY`) must point
 * to a key with chat-completions access.
 *
 * Optional config:
 *   - `endpoint`     override the default endpoint (Azure OpenAI etc.)
 *   - `extraHeaders` extra request headers (organization, project)
 */
export function createOpenAIAdapter(modelConfig = {}) {
  return createOpenRouterAdapter({
    ...modelConfig,
    provider: "openai",
    apiKeyEnv: modelConfig.apiKeyEnv || "OPENAI_API_KEY",
    endpoint: modelConfig.endpoint || OPENAI_ENDPOINT,
    extraHeaders: modelConfig.extraHeaders || {}
  });
}
