export const MODEL_ADAPTER_METHODS = ["respond", "repair", "critique", "capabilities"];

export const DEFAULT_MODEL_CAPABILITIES = {
  provider: "unknown",
  toolCalling: false,
  jsonMode: false,
  streaming: false,
  usage: false,
  fallbackModels: [],
  maxContext: null
};

export function normalizeModelCapabilities(capabilities = {}) {
  return {
    ...DEFAULT_MODEL_CAPABILITIES,
    ...capabilities,
    fallbackModels: Array.isArray(capabilities.fallbackModels) ? capabilities.fallbackModels : []
  };
}

export function assertModelAdapter(adapter) {
  const missing = MODEL_ADAPTER_METHODS.filter((method) => typeof adapter?.[method] !== "function");
  if (missing.length) {
    throw new Error(`Model adapter is missing required method(s): ${missing.join(", ")}`);
  }
  return adapter;
}
