// Local model adapter.
//
// Targets any OpenAI-compatible endpoint running on the user's machine
// or LAN — Ollama (`/v1/chat/completions` when started with
// `OLLAMA_API_KEY=local ollama serve`), LM Studio, vLLM, llama.cpp's
// `--api-server`, text-generation-webui's OpenAI extension, etc. The
// adapter delegates to the OpenAI-compatible transport already in
// `openrouter.js` and only supplies local-specific defaults.
import { createOpenRouterAdapter } from "./openrouter.js";

/**
 * Create a model adapter for a local OpenAI-compatible server.
 *
 * Required config:
 *   - `endpoint` or `baseUrl` — full chat-completions URL or its base
 *     (e.g. `http://localhost:11434/v1` for Ollama).
 *
 * Optional:
 *   - `apiKeyEnv` — env var holding an API key (Ollama and LM Studio
 *     accept any non-empty string). Defaults to `LAMP_LOCAL_API_KEY`.
 *   - `extraHeaders` — request headers (rarely needed locally).
 */
export function createLocalAdapter(modelConfig = {}) {
  if (!modelConfig.endpoint && !modelConfig.baseUrl) {
    throw new Error(
      "createLocalAdapter requires modelConfig.endpoint (e.g. " +
      "http://localhost:11434/v1/chat/completions) or modelConfig.baseUrl."
    );
  }
  return createOpenRouterAdapter({
    ...modelConfig,
    provider: "local",
    apiKeyEnv: modelConfig.apiKeyEnv || "LAMP_LOCAL_API_KEY",
    extraHeaders: modelConfig.extraHeaders || {}
  });
}
