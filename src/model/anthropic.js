// Anthropic adapter (Messages API).
//
// Implemented directly against the documented HTTP surface
// (https://docs.anthropic.com/en/api/messages) so the harness does
// not have to take a hard dependency on `@anthropic-ai/sdk`. The
// adapter exposes the same contract as the OpenAI-compatible
// adapters (capabilities / respond / repair / critique / streamText)
// and reuses the harness's TOOL_DEFINITIONS catalog by translating
// to Anthropic's `input_schema` shape.
//
// Scope of this adapter:
//   - non-streaming `respond` with tool calls
//   - non-streaming `repair` and `critique`
//   - text-only `streamText` via the SSE protocol
//   - usage and cost recorded under `model-usage.jsonl`
//
// Out of scope for now (will be reasonable to add later):
//   - streaming inside `respond`/`repair` (Anthropic's streaming
//     content_block_delta protocol with tool_use blocks is more
//     involved than OpenAI's; non-streaming is enough to cover the
//     basic flow)
//   - extended-thinking responses
//
// Prompt caching: opt in by setting `model.promptCaching = true` in
// `.agent/config.json`. When enabled, the adapter sends the
// `anthropic-beta: prompt-caching-2024-07-31` header and marks the
// system prompt with `cache_control: { type: "ephemeral" }` so
// cache hits skip the static system text on subsequent calls.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../log/event-log.js";
import { assertModelAdapter, normalizeModelCapabilities } from "./adapter-contract.js";
import { TOOL_DEFINITIONS, executeTool, compactPrePatchPlanForModel } from "./openrouter.js";

const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const SYSTEM_PROMPT = `You are a coding assistant working in the user's terminal. They communicate in plain English; reply at that level. Use the available tools to read, search, and edit files in their workspace, run their tests, and inspect git state — never claim to have read a file you have not. Prefer minimal reversible changes and be honest about what you have verified vs. what you are guessing.`;

export function createAnthropicAdapter(modelConfig = {}) {
  const capabilities = normalizeModelCapabilities({
    provider: "anthropic",
    toolCalling: modelConfig.capabilities?.toolCalling ?? true,
    jsonMode: Boolean(modelConfig.capabilities?.jsonMode),
    streaming: Boolean(modelConfig.capabilities?.streaming),
    usage: true,
    fallbackModels: Array.isArray(modelConfig.fallbackModels) ? modelConfig.fallbackModels : [],
    maxContext: modelConfig.maxContext || null
  });

  return assertModelAdapter({
    capabilities() {
      return capabilities;
    },

    async streamText({ messages = [], onToken = () => {}, activeTask = null, purpose = "stream" }) {
      const apiKey = process.env[modelConfig.apiKeyEnv || "ANTHROPIC_API_KEY"];
      if (!apiKey || !modelConfig.allowNetwork) {
        return {
          ok: false,
          message: apiKey && !modelConfig.allowNetwork
            ? "Streaming skipped because network model calls are disabled."
            : "Streaming skipped because Anthropic is not configured."
        };
      }
      try {
        const { text, usage } = await streamAnthropicMessage({
          apiKey,
          modelConfig,
          model: modelConfig.model,
          messages,
          system: SYSTEM_PROMPT,
          onToken,
          maxTokens: modelConfig.maxTokens || 1024
        });
        await recordModelUsage(activeTask, {
          provider: "anthropic",
          model: modelConfig.model,
          purpose,
          status: "ok",
          streaming: true,
          usage: normalizeAnthropicUsage(usage)
        });
        return { ok: true, message: text };
      } catch (error) {
        await recordModelUsage(activeTask, {
          provider: "anthropic",
          model: modelConfig.model,
          purpose,
          status: "failed",
          streaming: true,
          error: error.message
        });
        return { ok: false, message: `Streaming failed: ${error.message}` };
      }
    },

    async respond({ userRequest, projectSummary, prePatchPlan = null, tools, activeTask, allowedTools = null, onProgress = () => {}, onToken: _onToken = null, signal = null }) {
      const apiKey = process.env[modelConfig.apiKeyEnv || "ANTHROPIC_API_KEY"];
      if (!apiKey || !modelConfig.allowNetwork) {
        return localFallback(userRequest, projectSummary, apiKey, modelConfig.allowNetwork);
      }
      try {
        const userContent = [
          `User request: ${userRequest}`,
          "",
          "Initial project summary:",
          JSON.stringify(projectSummary, null, 2)
        ];
        const planContext = compactPrePatchPlanForModel(prePatchPlan);
        if (planContext) {
          userContent.push("", "Pre-patch plan (heuristic, advisory):", planContext);
        }
        const messages = [
          { role: "user", content: userContent.join("\n") }
        ];
        const tooling = anthropicTools(allowedTools, { promptCaching: !!modelConfig.promptCaching });

        const maxToolSteps = modelConfig.maxToolSteps || 32;
        for (let step = 0; step < maxToolSteps; step += 1) {
          const body = await callAnthropicMessage({
            apiKey,
            modelConfig,
            model: modelConfig.model,
            messages,
            system: SYSTEM_PROMPT,
            tools: tooling,
            maxTokens: modelConfig.maxTokens || 4096,
            signal
          });
          await recordModelUsage(activeTask, {
            provider: "anthropic",
            model: modelConfig.model,
            purpose: "respond",
            status: "ok",
            usage: normalizeAnthropicUsage(body.usage)
          });

          const blocks = Array.isArray(body.content) ? body.content : [];
          const textOut = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
          const toolUses = blocks.filter((block) => block.type === "tool_use");

          // Push the assistant message into the running history.
          messages.push({ role: "assistant", content: blocks });

          if (!toolUses.length) {
            return {
              message: textOut || "Done.",
              taskPatch: { current_plan: ["Inspect relevant files", "Answer in plain English"] }
            };
          }

          if (signal?.aborted) {
            throw signal.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" });
          }

          const toolResults = [];
          for (const toolUse of toolUses) {
            onProgress(`Using tool: ${toolUse.name}`);
            await logToolEvent(activeTask, toolUse.name, toolUse.input, "started");
            const result = await executeTool(toolUse.name, toolUse.input || {}, { tools, activeTask, allowedTools });
            await logToolEvent(activeTask, toolUse.name, toolUse.input, "completed", result);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: trimToolResult(result)
            });
          }
          messages.push({ role: "user", content: toolResults });
        }

        return {
          message: "Reached the tool-iteration limit before Anthropic produced a final answer.",
          taskPatch: { assumptions: ["Reached Anthropic tool-call loop limit."] }
        };
      } catch (error) {
        if (isAbortError(error)) {
          if (activeTask?.dir) {
            await appendEvent(activeTask.dir, {
              type: "model_aborted",
              phase: "respond",
              provider: "anthropic",
              message: "Anthropic request was cancelled before completion."
            });
          }
          return {
            message: "The model request was cancelled before completion.",
            taskPatch: { assumptions: ["The user cancelled the model request mid-flight."] },
            cancelled: true
          };
        }
        return {
          message: `The Anthropic call failed: ${error.message}.`,
          taskPatch: {}
        };
      }
    },

    async repair({ activeTask, tools, userRequest, failedChecks, attempt, maxAttempts, allowedTools = null, onToken: _onToken = null, signal: _signal = null }) {
      const apiKey = process.env[modelConfig.apiKeyEnv || "ANTHROPIC_API_KEY"];
      if (!apiKey || !modelConfig.allowNetwork) {
        return {
          ok: false,
          noop: true,
          message: apiKey && !modelConfig.allowNetwork
            ? "Repair skipped because network model calls are disabled."
            : "Repair skipped because Anthropic is not configured."
        };
      }
      try {
        const messages = [
          {
            role: "user",
            content: JSON.stringify({
              user_request: userRequest,
              attempt,
              max_attempts: maxAttempts,
              failed_checks: failedChecks
            }, null, 2)
          }
        ];
        const tooling = anthropicTools(allowedTools, { promptCaching: !!modelConfig.promptCaching });
        const maxRepairSteps = modelConfig.maxRepairSteps || 24;
        for (let step = 0; step < maxRepairSteps; step += 1) {
          const body = await callAnthropicMessage({
            apiKey,
            modelConfig,
            model: modelConfig.model,
            messages,
            system: `${SYSTEM_PROMPT}\n\nYou are now in a bounded repair attempt.`,
            tools: tooling,
            maxTokens: modelConfig.maxTokens || 4096
          });
          const blocks = Array.isArray(body.content) ? body.content : [];
          const textOut = blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
          const toolUses = blocks.filter((block) => block.type === "tool_use");
          messages.push({ role: "assistant", content: blocks });
          if (!toolUses.length) return { ok: true, message: textOut || "Repair attempt completed." };
          const toolResults = [];
          for (const toolUse of toolUses) {
            await logToolEvent(activeTask, toolUse.name, toolUse.input, "repair_started");
            const result = await executeTool(toolUse.name, toolUse.input || {}, { tools, activeTask, allowedTools });
            await logToolEvent(activeTask, toolUse.name, toolUse.input, "repair_completed", result);
            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: trimToolResult(result)
            });
          }
          messages.push({ role: "user", content: toolResults });
        }
        return { ok: false, message: "Anthropic repair attempt reached the tool-iteration limit." };
      } catch (error) {
        return { ok: false, message: `Repair failed: ${error.message}` };
      }
    },

    /**
     * Generic JSON-mode request. Anthropic does not accept an
     * OpenAI-style `response_format`, so the system prompt asks for
     * a single JSON object and the harness extracts it with the same
     * tolerant parser used elsewhere.
     */
    async respondJson({ system, user, activeTask = null, purpose = "respond_json" }) {
      const apiKey = process.env[modelConfig.apiKeyEnv || "ANTHROPIC_API_KEY"];
      if (!apiKey || !modelConfig.allowNetwork) {
        return {
          ok: false,
          message: apiKey && !modelConfig.allowNetwork
            ? "Structured request skipped because network model calls are disabled."
            : "Structured request skipped because Anthropic is not configured."
        };
      }
      try {
        const messages = [];
        const systemMsg = [
          system || "Respond with a single JSON object that matches the requested schema.",
          "Return only the JSON object, with no commentary or markdown fences."
        ].join("\n");
        if (user) messages.push({ role: "user", content: typeof user === "string" ? user : JSON.stringify(user, null, 2) });
        const body = await callAnthropicMessage({
          apiKey,
          modelConfig,
          model: modelConfig.model,
          messages,
          system: systemMsg,
          maxTokens: modelConfig.maxTokens || 1024
        });
        await recordModelUsage(activeTask, {
          provider: "anthropic",
          model: modelConfig.model,
          purpose,
          status: "ok",
          usage: normalizeAnthropicUsage(body.usage)
        });
        const text = (body.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
        const parsed = parseRawJson(text);
        return parsed != null
          ? { ok: true, raw: text, structured: parsed }
          : { ok: false, raw: text, message: "Anthropic response was not valid JSON." };
      } catch (error) {
        return { ok: false, message: `Structured request failed: ${error.message}` };
      }
    },

    async critique(context) {
      const apiKey = process.env[modelConfig.apiKeyEnv || "ANTHROPIC_API_KEY"];
      if (!apiKey || !modelConfig.allowNetwork) {
        return {
          ok: false,
          message: apiKey && !modelConfig.allowNetwork
            ? "Model critique skipped because network model calls are disabled."
            : "Model critique skipped because Anthropic is not configured."
        };
      }
      try {
        const body = await callAnthropicMessage({
          apiKey,
          modelConfig,
          model: modelConfig.model,
          messages: [
            { role: "user", content: JSON.stringify(context, null, 2) }
          ],
          system: [
            "You are a senior code reviewer critiquing an AI coding harness task before final review.",
            "Focus on likely bugs, unrelated behavior changes, weak assumptions, and missing verification.",
            "Be concise and plain-English. Do not invent facts beyond the provided context.",
            capabilities.jsonMode
              ? `Return strict JSON: ${JSON.stringify({ status: "reviewed", summary: "...", findings: [{ severity: "warning", text: "..." }], questions: [] })}`
              : ""
          ].filter(Boolean).join("\n"),
          maxTokens: modelConfig.maxTokens || 1024
        });
        const text = (body.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
        const structured = capabilities.jsonMode ? parseStructuredJson(text) : null;
        return {
          ok: true,
          message: structured ? structured.summary || text : text,
          structured
        };
      } catch (error) {
        return { ok: false, message: `Anthropic critique failed: ${error.message}` };
      }
    }
  });
}

/* ---------------- HTTP helpers ---------------- */

async function callAnthropicMessage({ apiKey, modelConfig, model, messages, system, tools, maxTokens, signal = null }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages(messages)
  };
  if (system) body.system = systemPayload(system, modelConfig);
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  const response = await fetch(modelConfig.endpoint || DEFAULT_ENDPOINT, {
    method: "POST",
    headers: anthropicHeaders(apiKey, modelConfig),
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const error = new Error(`Anthropic returned ${response.status}`);
    error.status = response.status;
    error.transient = response.status === 429 || response.status >= 500;
    throw error;
  }
  return response.json();
}

async function streamAnthropicMessage({ apiKey, modelConfig, model, messages, system, onToken, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages(messages),
    stream: true
  };
  if (system) body.system = systemPayload(system, modelConfig);

  const response = await fetch(modelConfig.endpoint || DEFAULT_ENDPOINT, {
    method: "POST",
    headers: anthropicHeaders(apiKey, modelConfig),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const error = new Error(`Anthropic returned ${response.status}`);
    error.status = response.status;
    error.transient = response.status === 429 || response.status >= 500;
    throw error;
  }
  if (!response.body?.getReader) throw new Error("Anthropic did not return a readable stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;

  const handleEvent = (data) => {
    if (!data) return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string") {
      text += parsed.delta.text;
      try { onToken(parsed.delta.text); } catch { /* ignore */ }
    }
    if (parsed.type === "message_delta" && parsed.usage) {
      usage = { ...usage, ...parsed.usage };
    }
    if (parsed.type === "message_start" && parsed.message?.usage) {
      usage = { ...usage, ...parsed.message.usage };
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      handleEvent(trimmed.slice("data:".length).trim());
    }
  }
  return { text, usage };
}

function systemPayload(system, modelConfig) {
  // When prompt caching is on, send the system prompt as an array of
  // text blocks with cache_control on the static piece. The next call
  // can skip recomputing the system prompt's tokens. Anthropic
  // tolerates plain strings too, so we keep that path for the
  // non-caching case to minimise body churn.
  if (modelConfig?.promptCaching) {
    return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  }
  return system;
}

function anthropicHeaders(apiKey, modelConfig) {
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json"
  };
  if (modelConfig?.promptCaching) {
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  }
  if (modelConfig?.extraHeaders && typeof modelConfig.extraHeaders === "object") {
    Object.assign(headers, modelConfig.extraHeaders);
  }
  return headers;
}

function anthropicMessages(messages) {
  // Anthropic expects messages as { role, content } pairs where content
  // is either a string or an array of typed blocks. The harness passes
  // OpenAI-style objects in the simple paths; pass through as-is.
  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    if (Array.isArray(message.content)) return message;
    return { ...message, content: String(message.content || "") };
  });
}

function anthropicTools(allowedTools, { promptCaching = false } = {}) {
  const allowed = new Set(allowedTools || []);
  const list = TOOL_DEFINITIONS
    .filter((tool) => !allowedTools || allowed.has(tool.function.name))
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters || { type: "object", properties: {} }
    }));
  // One cache breakpoint on the last tool covers system + tools as a
  // single block. Subsequent calls skip recomputing those tokens.
  // See https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  if (promptCaching && list.length) {
    list[list.length - 1] = {
      ...list[list.length - 1],
      cache_control: { type: "ephemeral" }
    };
  }
  return list;
}

function normalizeAnthropicUsage(usage) {
  if (!usage) return null;
  const inputTokens = usage.input_tokens ?? null;
  const outputTokens = usage.output_tokens ?? null;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null,
    cost: usage.cost ?? null
  };
}

async function recordModelUsage(activeTask, entry) {
  if (!activeTask?.dir) return;
  const payload = { ...entry, created_at: new Date().toISOString() };
  await mkdir(activeTask.dir, { recursive: true });
  await appendFile(path.join(activeTask.dir, "model-usage.jsonl"), `${JSON.stringify(payload)}\n`);
  await appendEvent(activeTask.dir, {
    type: "model_call",
    provider: payload.provider,
    model: payload.model,
    purpose: payload.purpose,
    status: payload.status,
    usage: payload.usage,
    error: payload.error,
    streaming: payload.streaming
  });
}

async function logToolEvent(activeTask, tool, args, status, result = null) {
  if (!activeTask?.dir) return;
  await appendEvent(activeTask.dir, {
    type: "tool_call",
    tool,
    status,
    args,
    result: result ? { ok: result.ok, blocked: result.blocked, message: result.message } : undefined
  });
}

function trimToolResult(result) {
  const json = JSON.stringify(result);
  if (json.length <= 12000) return json;
  return `${json.slice(0, 12000)}\n[truncated]`;
}

function isAbortError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (error.code === "ABORT_ERR" || error.code === 20) return true;
  return false;
}

function parseStructuredJson(content) {
  try {
    const parsed = JSON.parse(content);
    return {
      status: typeof parsed.status === "string" ? parsed.status : "reviewed",
      summary: typeof parsed.summary === "string" ? parsed.summary : "Critique completed.",
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions : []
    };
  } catch {
    return null;
  }
}

/**
 * Extract a JSON value from arbitrary model text. Tolerant of leading
 * commentary and markdown fences. Returns null when no JSON can be
 * recovered.
 */
function parseRawJson(content) {
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
  }
  const objStart = trimmed.indexOf("{");
  const objEnd = trimmed.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    try { return JSON.parse(trimmed.slice(objStart, objEnd + 1)); } catch { /* fall through */ }
  }
  return null;
}

function localFallback(userRequest, projectSummary, apiKey, allowNetwork) {
  const note = apiKey && !allowNetwork
    ? "Anthropic is configured but network model calls are disabled in `.agent/config.json`."
    : "No Anthropic API key is configured, so the local harness summary was used instead.";
  return {
    message: [
      note,
      "",
      `User request: ${userRequest}`,
      `Workspace: ${projectSummary?.fileCount || 0} file(s).`
    ].join("\n"),
    taskPatch: {
      assumptions: [
        apiKey && !allowNetwork
          ? "Network model calls are disabled by configuration."
          : "No Anthropic API key was configured, so no model-backed implementation was attempted."
      ]
    }
  };
}
