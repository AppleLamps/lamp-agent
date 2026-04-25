import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../log/event-log.js";
import { assertModelAdapter, normalizeModelCapabilities } from "./adapter-contract.js";

const SYSTEM_PROMPT = `You are an AI coding agent operating inside a permissioned coding harness.

The user communicates in plain English. Translate their request into technical work internally, but speak to them in product-level language.
Do not claim you inspected files unless the project summary provides evidence.
Prefer minimal, reversible changes.
Ask only when crossing meaningful boundaries: dependencies, network, secrets, database schema, deletion, outside-workspace access, push, deploy, payments, or production data.
Distinguish facts from guesses.
Use tools to inspect or change files. Do not pretend to have read files.
Prefer the code intelligence tools (find_symbols, find_definition, find_references, find_imports, find_exports, route_map) over raw text search when navigating real codebases.
For edits, prefer the smallest targeted primitive that fits: replace_exact for unique snippets, replace_range when you know line numbers, insert_before/insert_after for additions next to a unique marker, create_file for new files, rename_file/delete_file for file moves and deletes. Fall back to apply_patch for multi-hunk diffs and write_file only when you have read enough context to safely rewrite the whole file.
Final responses should summarize what changed, checks run, risks, and next choices.`;

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List workspace files under a path. Ignores common build and dependency directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to list.", default: "." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a workspace file. Secret-like files require user approval.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Workspace-relative file path." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search text across workspace files.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          glob: { type: "string", description: "Optional substring filter for paths." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a unified diff patch with tracked snapshots for undo. Preferred for code edits.",
      parameters: {
        type: "object",
        required: ["patch"],
        properties: {
          patch: { type: "string", description: "Unified diff text." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "preview_patch",
      description: "Project the effect of applying a unified diff without writing anything. Returns a per-file summary (added/removed/changed line counts plus a short preview). Useful for validating a patch before commit, or for showing the user a staged view.",
      parameters: {
        type: "object",
        required: ["patch"],
        properties: {
          patch: { type: "string", description: "Unified diff text." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a workspace file with snapshot tracking for undo. Use complete file content only when apply_patch is not practical.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description: "Create a new workspace file. Errors if the file already exists. Snapshots before write so undo can restore the missing-file state.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a workspace file. Snapshots first so undo can restore it. Always prompts the user for explicit approval.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description: "Rename or move a tracked workspace file. Errors if the destination already exists.",
      parameters: {
        type: "object",
        required: ["old_path", "new_path"],
        properties: {
          old_path: { type: "string" },
          new_path: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "replace_range",
      description: "Replace a 1-indexed inclusive line range in a file with new content. Prefer this over write_file for small edits when you know the line numbers.",
      parameters: {
        type: "object",
        required: ["path", "start_line", "end_line", "content"],
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", description: "1-indexed first line to replace." },
          end_line: { type: "integer", description: "1-indexed last line to replace, inclusive." },
          content: { type: "string", description: "New text to insert in place of the range. Empty string deletes the range." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "replace_exact",
      description: "Replace a single exact text snippet in a file with new text. Errors if the snippet appears zero or more than one times. Use a longer, unique snippet when ambiguous.",
      parameters: {
        type: "object",
        required: ["path", "old_text", "new_text"],
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "insert_before",
      description: "Insert text immediately before a unique marker substring in a file. Errors if the marker is missing or non-unique.",
      parameters: {
        type: "object",
        required: ["path", "marker", "content"],
        properties: {
          path: { type: "string" },
          marker: { type: "string" },
          content: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "insert_after",
      description: "Insert text immediately after a unique marker substring in a file. Errors if the marker is missing or non-unique.",
      parameters: {
        type: "object",
        required: ["path", "marker", "content"],
        properties: {
          path: { type: "string" },
          marker: { type: "string" },
          content: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a local command after deterministic permission classification. Risky commands prompt or block.",
      parameters: {
        type: "object",
        required: ["command", "purpose"],
        properties: {
          command: { type: "string" },
          purpose: { type: "string", description: "Plain-English purpose for this command." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_available_checks",
      description: "Run available package scripts among test, lint, typecheck, and build.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description: "Run the package test script if defined.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "run_lint",
      description: "Run the package lint script if defined.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "run_typecheck",
      description: "Run the package typecheck script if defined.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "run_build",
      description: "Run the package build script if defined.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show git status or tracked task changes when not in a git repo.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show git diff when this workspace is a git repo.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "find_symbols",
      description: "Search the code intelligence index for top-level symbols (functions, classes, interfaces, types, enums, variables) by substring of name. Optional kind filter narrows by symbol kind.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive substring of the symbol name. Empty matches all." },
          kind: { type: "string", description: "Optional kind filter: function, class, interface, type, enum, variable." },
          limit: { type: "integer", description: "Max matches to return. Default 50." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_definition",
      description: "Find where a symbol is defined. Returns one or more locations when an exact name match exists in the indexed source.",
      parameters: {
        type: "object",
        required: ["symbol"],
        properties: {
          symbol: { type: "string", description: "Exact symbol identifier." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_references",
      description: "Find references to a symbol across indexed source files using identifier word-boundary scan. Excludes the definition site when known.",
      parameters: {
        type: "object",
        required: ["symbol"],
        properties: {
          symbol: { type: "string", description: "Exact identifier to look up." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_imports",
      description: "List the imports declared in a workspace file (ESM, CommonJS, dynamic import, Python from/import).",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_exports",
      description: "List the exports declared in a workspace file (ESM named/default, CommonJS, Python module-level).",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "route_map",
      description: "Detect HTTP routes in the workspace. Covers Express/Fastify/Koa-style app.METHOD calls, React Router <Route path>, and Next.js pages/ and app/ file routes.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "detect_test_runner",
      description: "Detect the test runner used in this workspace (Jest, Vitest, Node, Mocha, Playwright, pytest, etc.).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "run_test_file",
      description: "Run a specific test file using the detected test runner instead of the full test suite.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Workspace-relative path to the test file." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_test_name",
      description: "Run a specific test by name or pattern using the detected test runner.",
      parameters: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", description: "Test name or pattern to filter by." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_related_tests",
      description: "Find and run test files related to a changed source file.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Workspace-relative path to the changed source file." }
        }
      }
    }
  }
];

export function createOpenRouterAdapter(modelConfig) {
  // The OpenAI-compatible transport here is shared by OpenRouter,
  // OpenAI, and any other provider speaking the same wire format. The
  // capability `provider` field reflects whatever the caller set so
  // reports and audit logs show the real provider name.
  const capabilities = normalizeModelCapabilities({
    provider: modelConfig.provider || "openrouter",
    toolCalling: modelConfig.capabilities?.toolCalling ?? true,
    jsonMode: Boolean(modelConfig.capabilities?.jsonMode),
    streaming: Boolean(modelConfig.capabilities?.streaming),
    usage: true,
    fallbackModels: modelConfig.fallbackModels || [],
    maxContext: modelConfig.maxContext || null
  });

  return assertModelAdapter({
    capabilities() {
      return capabilities;
    },

    async streamText({ messages, activeTask = null, onToken = () => {}, purpose = "stream" }) {
      const apiKey = process.env[modelConfig.apiKeyEnv];
      if (!apiKey || !modelConfig.allowNetwork) {
        return {
          ok: false,
          message: apiKey && !modelConfig.allowNetwork
            ? "Streaming skipped because network model calls are disabled."
            : "Streaming skipped because OpenRouter is not configured."
        };
      }
      if (!capabilities.streaming) {
        return { ok: false, message: "Streaming is not enabled for this model configuration." };
      }

      try {
        const text = await requestOpenRouterStream({ apiKey, modelConfig, messages, activeTask, purpose, onToken });
        return { ok: true, message: text };
      } catch (error) {
        return { ok: false, message: `Streaming failed: ${error.message}` };
      }
    },

    async respond({ userRequest, projectSummary, tools, activeTask, allowedTools = null, onProgress = () => {}, onToken = null, signal = null }) {
      const apiKey = process.env[modelConfig.apiKeyEnv];
      if (!apiKey || !modelConfig.allowNetwork) {
        return localHarnessResponse(userRequest, projectSummary, apiKey, modelConfig.allowNetwork);
      }

      try {
        const messages = [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `User request: ${userRequest}`,
              "",
              "Initial project summary:",
              JSON.stringify(projectSummary, null, 2),
              "",
              "Persisted project memory:",
              JSON.stringify(projectSummary.memory || null, null, 2)
            ].join("\n")
          }
        ];

        for (let step = 0; step < 8; step += 1) {
          const body = await requestOpenRouter({
            apiKey,
            modelConfig,
            messages,
            options: { allowedTools },
            activeTask,
            purpose: "respond",
            onToken,
            signal
          });
          const message = body.choices?.[0]?.message;
          if (!message) {
            return {
              message: "The model provider returned no message. I stopped before making further changes.",
              taskPatch: { current_plan: inferPlan(userRequest, projectSummary) }
            };
          }

          messages.push(message);
          const toolCalls = message.tool_calls || [];
          if (!toolCalls.length) {
            return {
              message: message.content || "Done.",
              taskPatch: { current_plan: inferPlan(userRequest, projectSummary) }
            };
          }

          for (const toolCall of toolCalls) {
            const name = toolCall.function?.name;
            const args = parseToolArgs(toolCall.function?.arguments);
            onProgress(`Using tool: ${name}`);
            await logToolEvent(activeTask, name, args, "started");
            const result = await executeTool(name, args, { tools, activeTask, allowedTools });
            await logToolEvent(activeTask, name, args, "completed", result);
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name,
              content: JSON.stringify(trimToolResult(result))
            });
            if (signal?.aborted) {
              throw signal.reason ?? Object.assign(new Error("Aborted"), { name: "AbortError" });
            }
          }
        }

        return {
          message: "I reached the tool-iteration limit before the model produced a final answer. Review the task artifacts for partial progress.",
          taskPatch: {
            current_plan: inferPlan(userRequest, projectSummary),
            assumptions: ["The model reached the maximum tool-call loop limit."]
          }
        };
      } catch (error) {
        if (isAbortError(error)) {
          if (activeTask?.dir) {
            await appendEvent(activeTask.dir, {
              type: "model_aborted",
              phase: "respond",
              message: "Model request was cancelled before completion."
            });
          }
          return {
            message: "The model request was cancelled before completion.",
            taskPatch: {
              assumptions: ["The user cancelled the model request mid-flight."]
            },
            cancelled: true
          };
        }
        return {
          message: `The model call failed: ${error.message}. I inspected the workspace locally instead.\n\n${formatLocalSummary(projectSummary)}`,
          taskPatch: {}
        };
      }
    },

    async critique(context) {
      const apiKey = process.env[modelConfig.apiKeyEnv];
      if (!apiKey || !modelConfig.allowNetwork) {
        return {
          ok: false,
          message: apiKey && !modelConfig.allowNetwork
            ? "Model critique skipped because network model calls are disabled."
            : "Model critique skipped because OpenRouter is not configured."
        };
      }

      try {
        const body = await requestOpenRouter({ apiKey, modelConfig, activeTask: context.activeTask, purpose: "critique", messages: [
          {
            role: "system",
            content: critiqueSystemPrompt(capabilities)
          },
          {
            role: "user",
            content: JSON.stringify(context, null, 2)
          }
        ], options: { tools: false, jsonMode: capabilities.jsonMode } });

        const content = body.choices?.[0]?.message?.content || "Model critique completed with no comments.";
        const structured = capabilities.jsonMode ? parseStructuredJson(content) : null;

        return {
          ok: true,
          message: structured ? structured.summary || content : content,
          structured
        };
      } catch (error) {
        return { ok: false, message: `Model critique failed: ${error.message}` };
      }
    },

    async repair({ activeTask, tools, userRequest, projectSummary, failedChecks, attempt, maxAttempts, allowedTools = null }) {
      const apiKey = process.env[modelConfig.apiKeyEnv];
      if (!apiKey || !modelConfig.allowNetwork) {
        return {
          ok: false,
          noop: true,
          message: apiKey && !modelConfig.allowNetwork
            ? "Repair skipped because network model calls are disabled."
            : "Repair skipped because OpenRouter is not configured."
        };
      }

      try {
        const messages = [
          {
            role: "system",
            content: [
              SYSTEM_PROMPT,
              "",
              "You are now in a bounded repair attempt.",
              "Use tools to inspect the failure and make the smallest patch likely to fix it.",
              "Do not broaden scope. Stop with a concise summary when done."
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              user_request: userRequest,
              project_summary: projectSummary,
              attempt,
              max_attempts: maxAttempts,
              failed_checks: failedChecks
            }, null, 2)
          }
        ];

        for (let step = 0; step < 6; step += 1) {
          const body = await requestOpenRouter({ apiKey, modelConfig, messages, options: { allowedTools }, activeTask, purpose: "repair" });
          const message = body.choices?.[0]?.message;
          if (!message) return { ok: false, message: "Repair model returned no message." };
          messages.push(message);
          const toolCalls = message.tool_calls || [];
          if (!toolCalls.length) {
            return { ok: true, message: message.content || "Repair attempt completed." };
          }
          for (const toolCall of toolCalls) {
            const name = toolCall.function?.name;
            const args = parseToolArgs(toolCall.function?.arguments);
            await logToolEvent(activeTask, name, args, "repair_started");
            const result = await executeTool(name, args, { tools, activeTask, allowedTools });
            await logToolEvent(activeTask, name, args, "repair_completed", result);
            messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name,
              content: JSON.stringify(trimToolResult(result))
            });
          }
        }

        return { ok: false, message: "Repair attempt reached the tool-iteration limit." };
      } catch (error) {
        return { ok: false, message: `Repair failed: ${error.message}` };
      }
    }
  });
}

async function logToolEvent(activeTask, tool, args, status, result = null) {
  if (!activeTask?.dir) return;
  await appendEvent(activeTask.dir, {
    type: "tool_call",
    tool,
    status,
    args: redactArgs(args),
    result: result ? summarizeToolResult(result) : undefined
  });
}

function redactArgs(args) {
  if (!args) return {};
  const redacted = { ...args };
  if (typeof redacted.content === "string" && redacted.content.length > 200) {
    redacted.content = `[${redacted.content.length} chars]`;
  }
  return redacted;
}

function summarizeToolResult(result) {
  return {
    ok: result.ok,
    skipped: result.skipped,
    blocked: result.blocked,
    message: result.message,
    decision: result.decision
  };
}

async function requestOpenRouter({ apiKey, modelConfig, messages, options = { tools: true }, activeTask = null, purpose = "model_call", onToken = null, signal = null }) {
  const models = modelCandidates(modelConfig);
  const maxRetries = Number.isInteger(modelConfig.maxRetries) ? modelConfig.maxRetries : 2;
  // Stream when the caller asked for it (via onToken) and the model
  // configuration advertises streaming capability. Otherwise fall back
  // to the existing single-shot fetch.
  const useStreaming = typeof onToken === "function" && Boolean(modelConfig.capabilities?.streaming);
  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const body = useStreaming
          ? await streamOpenRouterChat(apiKey, modelConfig, model, messages, options, { onToken, signal })
          : await callOpenRouter(apiKey, modelConfig, model, messages, options, { signal });
        await recordModelUsage(activeTask, {
          provider: modelConfig.provider || "openrouter",
          model,
          purpose,
          attempt: attempt + 1,
          fallback: model !== modelConfig.model,
          usage: normalizeUsage(body.usage),
          status: "ok",
          streaming: useStreaming
        });
        return body;
      } catch (error) {
        lastError = error;
        await recordModelUsage(activeTask, {
          provider: modelConfig.provider || "openrouter",
          model,
          purpose,
          attempt: attempt + 1,
          fallback: model !== modelConfig.model,
          status: "failed",
          transient: isTransientProviderError(error),
          error: error.message,
          streaming: useStreaming
        });
        // Aborted requests must not retry — propagate immediately so
        // the caller can shut down cleanly.
        if (isAbortError(error)) throw error;
        if (!isTransientProviderError(error)) throw error;
        if (attempt < maxRetries) {
          await sleep(retryDelayMs(modelConfig, attempt));
        }
      }
    }
  }

  throw lastError || new Error("OpenRouter request failed.");
}

async function callOpenRouter(apiKey, modelConfig, model, messages, options = { tools: true }, { signal = null } = {}) {
  const body = {
    model,
    messages
  };
  if (options.tools !== false) {
    body.tools = filterToolDefinitions(options.allowedTools);
    body.tool_choice = "auto";
  }
  if (options.jsonMode && modelConfig.capabilities?.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetch(resolveEndpoint(modelConfig), {
    method: "POST",
    headers: resolveHeaders(modelConfig, apiKey),
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const error = providerError(modelConfig, response.status);
    throw error;
  }
  return response.json();
}

/**
 * Stream a chat completion from OpenRouter and reassemble it into the
 * same shape `callOpenRouter` returns (`{ choices: [{ message,
 * finish_reason }], usage }`). Text content is forwarded through
 * `onToken` as it arrives; tool-call deltas are accumulated by index
 * so the caller's existing tool-dispatch loop is unchanged.
 */
async function streamOpenRouterChat(apiKey, modelConfig, model, messages, options = { tools: true }, { onToken = () => {}, signal = null } = {}) {
  const body = {
    model,
    messages,
    stream: true
  };
  if (options.tools !== false) {
    body.tools = filterToolDefinitions(options.allowedTools);
    body.tool_choice = "auto";
  }
  if (options.jsonMode && modelConfig.capabilities?.jsonMode) {
    body.response_format = { type: "json_object" };
  }
  // OpenRouter passes through usage when `stream_options.include_usage`
  // is set. Without this, the streamed chunks omit usage and we fall
  // back to recording a `null` usage record.
  body.stream_options = { include_usage: true };

  const response = await fetch(resolveEndpoint(modelConfig), {
    method: "POST",
    headers: resolveHeaders(modelConfig, apiKey),
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    throw providerError(modelConfig, response.status);
  }
  if (!response.body?.getReader) {
    throw new Error("Provider did not return a readable stream for chat.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCallsByIndex = new Map();
  let finishReason = null;
  let usage = null;

  const handleEvent = (data) => {
    if (!data || data === "[DONE]") return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const choice = parsed.choices?.[0];
    if (choice?.delta?.content) {
      content += choice.delta.content;
      try {
        onToken(choice.delta.content);
      } catch {
        /* onToken throwing must not break the stream */
      }
    }
    if (Array.isArray(choice?.delta?.tool_calls)) {
      for (const tcDelta of choice.delta.tool_calls) {
        accumulateToolCallDelta(toolCallsByIndex, tcDelta);
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (parsed.usage) usage = parsed.usage;
  };

  try {
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
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        handleEvent(trimmed.slice("data:".length).trim());
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, tc]) => ({
      id: tc.id,
      type: tc.type || "function",
      function: {
        name: tc.function?.name || "",
        arguments: tc.function?.arguments || ""
      }
    }));

  const message = {
    role: "assistant",
    content: content || null
  };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    choices: [{ message, finish_reason: finishReason }],
    usage
  };
}

function accumulateToolCallDelta(map, delta) {
  if (!delta || delta.index === undefined) return;
  const key = String(delta.index);
  const existing = map.get(key) || { index: delta.index, function: {} };
  if (delta.id && !existing.id) existing.id = delta.id;
  if (delta.type && !existing.type) existing.type = delta.type;
  if (delta.function?.name) {
    existing.function.name = (existing.function.name || "") + delta.function.name;
  }
  if (typeof delta.function?.arguments === "string") {
    existing.function.arguments = (existing.function.arguments || "") + delta.function.arguments;
  }
  map.set(key, existing);
}

function isAbortError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (error.code === "ABORT_ERR" || error.code === 20) return true;
  return false;
}

async function requestOpenRouterStream({ apiKey, modelConfig, messages, activeTask = null, purpose = "stream", onToken = () => {} }) {
  const models = modelCandidates(modelConfig);
  const maxRetries = Number.isInteger(modelConfig.maxRetries) ? modelConfig.maxRetries : 2;
  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const text = await streamOpenRouter(apiKey, modelConfig, model, messages, onToken);
        await recordModelUsage(activeTask, {
          provider: modelConfig.provider || "openrouter",
          model,
          purpose,
          attempt: attempt + 1,
          fallback: model !== modelConfig.model,
          status: "ok",
          streaming: true
        });
        return text;
      } catch (error) {
        lastError = error;
        await recordModelUsage(activeTask, {
          provider: modelConfig.provider || "openrouter",
          model,
          purpose,
          attempt: attempt + 1,
          fallback: model !== modelConfig.model,
          status: "failed",
          transient: isTransientProviderError(error),
          streaming: true,
          error: error.message
        });
        if (!isTransientProviderError(error)) throw error;
        if (attempt < maxRetries) await sleep(retryDelayMs(modelConfig, attempt));
      }
    }
  }

  throw lastError || new Error("OpenRouter stream failed.");
}

async function streamOpenRouter(apiKey, modelConfig, model, messages, onToken) {
  const response = await fetch(resolveEndpoint(modelConfig), {
    method: "POST",
    headers: resolveHeaders(modelConfig, apiKey),
    body: JSON.stringify({
      model,
      messages,
      stream: true
    })
  });
  if (!response.ok) {
    throw providerError(modelConfig, response.status);
  }
  if (!response.body?.getReader) {
    throw new Error("Provider did not return a readable stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const token = parseStreamLine(line);
      if (!token) continue;
      text += token;
      onToken(token);
    }
  }

  const trailing = parseStreamLine(buffer);
  if (trailing) {
    text += trailing;
    onToken(trailing);
  }
  return text;
}

function parseStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return "";
  const data = trimmed.slice("data:".length).trim();
  if (!data || data === "[DONE]") return "";
  try {
    const parsed = JSON.parse(data);
    return parsed.choices?.[0]?.delta?.content || "";
  } catch {
    return "";
  }
}

function modelCandidates(modelConfig) {
  return [
    modelConfig.model,
    ...(Array.isArray(modelConfig.fallbackModels) ? modelConfig.fallbackModels : [])
  ].filter(Boolean).filter((model, index, list) => list.indexOf(model) === index);
}

// ---- Provider transport helpers ----------------------------------------
//
// The chat-completion code in this file is OpenAI-format-compatible: it works
// against any provider that speaks the same /chat/completions wire format
// (OpenAI itself, OpenRouter, vLLM, Ollama in OpenAI-compat mode, LM Studio,
// llama.cpp's `--api-server`, etc.). The only per-provider differences are
// the endpoint URL and any extra HTTP headers. The helpers below let a
// `modelConfig` override these without changing any of the call sites.
//
// Defaults match OpenRouter so the original `createOpenRouterAdapter`
// behavior is preserved when nothing is configured.

const DEFAULT_OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_EXTRA_HEADERS = {
  "HTTP-Referer": "http://localhost",
  "X-Title": "Plain-English AI Coding Harness"
};

function resolveEndpoint(modelConfig) {
  if (typeof modelConfig?.endpoint === "string" && modelConfig.endpoint.length) {
    return modelConfig.endpoint;
  }
  if (typeof modelConfig?.baseUrl === "string" && modelConfig.baseUrl.length) {
    // `baseUrl` is the OpenAI / Ollama / LM Studio convention; append the
    // chat-completions path if the user gave us a base.
    const base = modelConfig.baseUrl.replace(/\/+$/, "");
    return `${base}/chat/completions`;
  }
  return DEFAULT_OPENROUTER_ENDPOINT;
}

function resolveHeaders(modelConfig, apiKey) {
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  const extra = modelConfig?.extraHeaders;
  if (extra && typeof extra === "object") {
    Object.assign(headers, extra);
  } else if (modelConfig?.endpoint || modelConfig?.baseUrl) {
    // The caller pointed us at a non-OpenRouter endpoint and did not
    // supply extraHeaders; in that case do not silently send
    // OpenRouter's `HTTP-Referer`/`X-Title` headers.
  } else {
    Object.assign(headers, DEFAULT_OPENROUTER_EXTRA_HEADERS);
  }
  return headers;
}

function providerError(modelConfig, status) {
  const provider = modelConfig?.provider || "provider";
  const error = new Error(`${provider} returned ${status}`);
  error.status = status;
  error.transient = status === 429 || status >= 500;
  return error;
}

function isTransientProviderError(error) {
  if (error?.transient) return true;
  if (error?.status === 429 || error?.status >= 500) return true;
  return /fetch failed|network|timeout|temporar/i.test(error?.message || "");
}

function retryDelayMs(modelConfig, attempt) {
  const base = Number.isFinite(modelConfig.retryBaseDelayMs) ? modelConfig.retryBaseDelayMs : 250;
  return Math.max(0, base * (2 ** attempt));
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    cost: usage.cost ?? null
  };
}

async function recordModelUsage(activeTask, entry) {
  if (!activeTask?.dir) return;
  const payload = {
    ...entry,
    created_at: new Date().toISOString()
  };
  await mkdir(activeTask.dir, { recursive: true });
  await appendFile(path.join(activeTask.dir, "model-usage.jsonl"), `${JSON.stringify(payload)}\n`);
  await appendEvent(activeTask.dir, {
    type: "model_call",
    provider: payload.provider,
    model: payload.model,
    purpose: payload.purpose,
    status: payload.status,
    transient: payload.transient,
    fallback: payload.fallback,
    usage: payload.usage,
    error: payload.error
  });
}

export async function executeTool(name, args, { tools, activeTask, allowedTools = null }) {
  if (allowedTools && !allowedTools.includes(name)) {
    return { ok: false, blocked: true, message: `Tool ${name} is not allowed in the current phase.` };
  }
  switch (name) {
    case "list_files":
      return tools.listFiles(args.path || ".");
    case "read_file":
      return tools.readFile(args.path);
    case "search_files":
      return tools.searchFiles(args.query, args.glob);
    case "apply_patch":
      return tools.applyPatchTracked(activeTask, args.patch);
    case "preview_patch":
      return tools.previewPatch(args.patch);
    case "write_file":
      return tools.writeFileTracked(activeTask, args.path, args.content);
    case "create_file":
      return tools.createFileTracked(activeTask, args.path, args.content);
    case "delete_file":
      return tools.deleteFileTracked(activeTask, args.path);
    case "rename_file":
      return tools.renameFileTracked(activeTask, args.old_path, args.new_path);
    case "replace_range":
      return tools.replaceRangeTracked(activeTask, args.path, args.start_line, args.end_line, args.content);
    case "replace_exact":
      return tools.replaceExactTracked(activeTask, args.path, args.old_text, args.new_text);
    case "insert_before":
      return tools.insertBeforeTracked(activeTask, args.path, args.marker, args.content);
    case "insert_after":
      return tools.insertAfterTracked(activeTask, args.path, args.marker, args.content);
    case "run_command":
      return tools.runCommand(args.command, args.purpose, activeTask);
    case "run_available_checks":
      return tools.runAvailableChecks(activeTask);
    case "run_tests":
      return tools.runTests(activeTask);
    case "run_lint":
      return tools.runLint(activeTask);
    case "run_typecheck":
      return tools.runTypecheck(activeTask);
    case "run_build":
      return tools.runBuild(activeTask);
    case "git_status":
      return tools.gitStatus();
    case "git_diff":
      return tools.gitDiff();
    case "find_symbols":
      return tools.findSymbols(args.query || "", { kind: args.kind, limit: args.limit });
    case "find_definition":
      return tools.findDefinition(args.symbol);
    case "find_references":
      return tools.findReferences(args.symbol);
    case "find_imports":
      return tools.findImports(args.path);
    case "find_exports":
      return tools.findExports(args.path);
    case "route_map":
      return tools.routeMap();
    case "detect_test_runner":
      return tools.detectTestRunner();
    case "run_test_file":
      return tools.runTestFile(args.path, activeTask);
    case "run_test_name":
      return tools.runTestName(args.name, activeTask);
    case "run_related_tests":
      return tools.runRelatedTests(args.path, activeTask);
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

function filterToolDefinitions(allowedTools) {
  if (!allowedTools) return TOOL_DEFINITIONS;
  const allowed = new Set(allowedTools);
  return TOOL_DEFINITIONS.filter((tool) => allowed.has(tool.function.name));
}

function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function trimToolResult(result) {
  const json = JSON.stringify(result);
  if (json.length <= 12000) return result;
  return {
    ok: result.ok,
    truncated: true,
    preview: json.slice(0, 12000)
  };
}

function critiqueSystemPrompt(capabilities) {
  const base = [
    "You are a senior code reviewer critiquing an AI coding harness task before final review.",
    "Focus on likely bugs, unrelated behavior changes, weak assumptions, and missing verification.",
    "Be concise and plain-English. Do not invent facts beyond the provided context."
  ];
  if (!capabilities.jsonMode) return base.join("\n");
  return [
    ...base,
    "Return strict JSON with this shape:",
    JSON.stringify({
      status: "reviewed",
      summary: "Short summary.",
      findings: [{ severity: "warning", text: "Finding text." }],
      questions: ["Open question."]
    })
  ].join("\n");
}

function parseStructuredJson(content) {
  try {
    const parsed = JSON.parse(content);
    return {
      status: typeof parsed.status === "string" ? parsed.status : "reviewed",
      summary: typeof parsed.summary === "string" ? parsed.summary : "Model critique completed.",
      findings: Array.isArray(parsed.findings) ? parsed.findings.map(normalizeFinding).filter(Boolean) : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions.filter((q) => typeof q === "string") : []
    };
  } catch {
    return null;
  }
}

function normalizeFinding(finding) {
  if (!finding || typeof finding.text !== "string") return null;
  const severity = ["error", "warning", "info"].includes(finding.severity) ? finding.severity : "info";
  return { severity, text: finding.text };
}

function localHarnessResponse(userRequest, projectSummary, apiKey, allowNetwork) {
  const modelNote = apiKey && !allowNetwork
    ? "OpenRouter is configured, but network model calls are disabled in `.agent/config.json`."
    : "No OpenRouter API key is configured, so I used the local harness summary.";

  return {
    message: [
      modelNote,
      "",
      formatLocalSummary(projectSummary),
      "",
      `For this request, the next implementation step is: ${nextStep(userRequest, projectSummary)}`
    ].join("\n"),
    taskPatch: {
      current_plan: inferPlan(userRequest, projectSummary),
      assumptions: apiKey && !allowNetwork
        ? ["Network model calls are disabled by configuration."]
        : ["No model-backed implementation was attempted because OpenRouter is not enabled."]
    }
  };
}

function formatLocalSummary(projectSummary) {
  const lines = [
    `I found ${projectSummary.fileCount} file(s) in the workspace.`,
    projectSummary.memory?.framework
      ? `Remembered framework: ${projectSummary.memory.framework}.`
      : null,
    projectSummary.packageManager
      ? `Package manager: ${projectSummary.packageManager}.`
      : "No package manager was detected.",
    projectSummary.testRunner
      ? `Test runner: ${projectSummary.testRunner}.`
      : null,
    projectSummary.scripts.length
      ? `Available package scripts: ${projectSummary.scripts.join(", ")}.`
      : "No package scripts were found.",
    projectSummary.git
  ];
  if (projectSummary.notableFiles.length) {
    lines.push(`Notable files: ${projectSummary.notableFiles.join(", ")}.`);
  }
  return lines.filter(Boolean).join("\n");
}

function nextStep(userRequest, projectSummary) {
  if (projectSummary.fileCount <= 3) {
    return "continue building the harness foundation before asking it to modify another project.";
  }
  if (/\b(explain|where|what|why|how)\b/i.test(userRequest)) {
    return "read the relevant files and answer from evidence.";
  }
  return "inspect likely implementation files, create a short plan, then make reversible local edits.";
}

function inferPlan(userRequest, projectSummary) {
  const plan = ["Inspect relevant project files"];
  if (!/\b(explain|where|what|why|how)\b/i.test(userRequest)) {
    plan.push("Make minimal reversible changes");
    if (projectSummary.scripts.length) plan.push("Run available local checks");
    plan.push("Summarize changed files and risks");
  } else {
    plan.push("Separate confirmed facts from assumptions");
    plan.push("Answer in plain English");
  }
  return plan;
}
