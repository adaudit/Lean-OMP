import crypto from "node:crypto";
import { formatConfig, loadConfig } from "./config.js";
import { isSnapshotPoll, pollBlockReason, pollingKey } from "./polling.js";
import { LeanStore, resolveSessionId } from "./store.js";
import { analyzeTaskInput, taskBlockReason } from "./task-policy.js";
import { estimateTokens } from "./tokens.js";

export const LEAN_OMP_VERSION = "1.0.0";

export function extensionCapabilities(pi) {
  const missing = ["on", "registerTool", "registerCommand"].filter(
    (capability) => typeof pi?.[capability] !== "function",
  );
  if (
    !pi?.zod ||
    typeof pi.zod.object !== "function" ||
    typeof pi.zod.enum !== "function" ||
    typeof pi.zod.string !== "function" ||
    typeof pi.zod.array !== "function"
  ) {
    missing.push("zod");
  }
  return { compatible: missing.length === 0, missing };
}

function logger(pi, level, message) {
  try {
    const method = pi?.logger?.[level];
    if (typeof method === "function") method.call(pi.logger, message);
  } catch {
    // Observability must never break the agent runtime.
  }
}

function resultText(event, limit = 4_000) {
  const content = Array.isArray(event?.content) ? event.content : [];
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .slice(0, limit);
}

export function redactCheckpoint(value, limit = 16 * 1024) {
  const redacted = String(value || "")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(AIza[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]")
    .replace(/((?:password|passwd|token|api[_-]?key|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, "$1[REDACTED]");
  return redacted.slice(0, limit);
}

function orchestrationPolicy(config, status) {
  const interrupted = status.taskCounts.interrupted || 0;
  const artifactNames = status.artifacts.slice(0, 12).map((artifact) => artifact.name);
  return [
    "Lean-OMP orchestration policy (OMP-native, Orca-scoped):",
    `- Keep every delegated agent packet below ${config.maxTaskPacketTokens} estimated tokens. Include only Objective, Scope, Relevant paths/symbols, Required dependency artifacts, Deliverable, and Acceptance criteria.`,
    "- Do not copy the coordinator transcript or large file bodies into task prompts. Store durable findings with lean_artifact and reference their names or source paths/ranges.",
    "- Use OMP's native task tool for delegation. Background task results auto-deliver; do not repeatedly snapshot hub jobs. Use hub wait only when genuinely blocked.",
    "- Prefer deterministic tools/tests for validation. Commission another model reviewer only when risk or unresolved ambiguity justifies it.",
    "- Before retrying interrupted work, inspect lean_artifact status and reuse completed artifacts. Never repeat an uncertain side effect without checking durable state.",
    `- Durable state currently reports ${interrupted} interrupted task(s) and ${status.artifacts.length} artifact(s)${artifactNames.length ? `: ${artifactNames.join(", ")}` : "."}`,
  ].join("\n");
}

function commandReport(pi, customType, report, ctx) {
  const content = JSON.stringify(report, null, 2);
  try {
    pi.sendMessage(
      { customType, content, display: true, attribution: "extension" },
      { triggerTurn: false },
    );
  } catch {
    ctx.ui.notify(content, "info");
  }
}

export function createLeanOmpRuntime(pi, options = {}) {
  const env = options.env || process.env;
  const config = options.config || loadConfig(env);
  const capabilities = extensionCapabilities(pi);
  const stores = new Map();
  const processInstance = options.processInstance || crypto.randomUUID();
  let lastContextSampleAt = 0;
  let lastContextTokens = 0;

  const storeFor = (ctx) => {
    const sessionId = resolveSessionId(ctx, env);
    const key = `${ctx.cwd}:${sessionId}`;
    if (!stores.has(key)) {
      stores.set(
        key,
        new LeanStore({
          cwd: ctx.cwd,
          config,
          sessionId,
          now: options.now,
          processId: options.processId,
          processInstance,
          isProcessAlive: options.isProcessAlive,
        }),
      );
    }
    return stores.get(key);
  };

  const safely = (ctx, operation) => {
    try {
      return operation(storeFor(ctx));
    } catch (error) {
      logger(pi, "warn", `[lean-omp] ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  return { config, capabilities, storeFor, safely, state: { stores } };
}

export default function leanOmp(pi) {
  const runtime = createLeanOmpRuntime(pi);
  const { config, capabilities, safely, storeFor } = runtime;
  const lastTaskHeartbeat = new Map();
  const terminalProgress = new Set();

  if (!capabilities.compatible) {
    logger(pi, "warn", `[lean-omp] disabled: missing extension capabilities ${capabilities.missing.join(", ")}`);
    return;
  }

  pi.registerCommand("lean-doctor", {
    description: "Show Lean-OMP activation, compatibility, and safety limits",
    handler: async (_args, ctx) => {
      commandReport(
        pi,
        "lean-omp-doctor",
        {
          pluginVersion: LEAN_OMP_VERSION,
          compatible: capabilities.compatible,
          missingCapabilities: capabilities.missing,
          ...formatConfig(config),
        },
        ctx,
      );
    },
  });

  if (!config.active) {
    logger(pi, "debug", "[lean-omp] inactive outside Orca; set LEAN_OMP_MODE=observe|enforce to override");
    return;
  }

  const z = pi.zod;
  pi.registerTool({
    name: "lean_artifact",
    label: "Lean Artifact",
    description:
      "Persist or recover compact orchestration findings without copying chat history. Use op=write after a meaningful finding or completed task; use status/read before retrying interrupted work.",
    parameters: z.object({
      op: z.enum(["write", "read", "list", "status"]),
      name: z.string().optional(),
      summary: z.string().optional(),
      evidence: z.array(z.string()).optional(),
      status: z.enum(["in_progress", "complete", "blocked", "failed"]).optional(),
      dependencies: z.array(z.string()).optional(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Lean artifact operation cancelled." }], isError: true };
      }
      try {
        const store = storeFor(ctx);
        let result;
        if (params.op === "write") {
          if (!params.name?.trim() || !params.summary?.trim()) {
            throw new Error("lean_artifact write requires non-empty name and summary fields.");
          }
          result = store.writeArtifact({
            name: params.name,
            summary: params.summary,
            evidence: params.evidence,
            status: params.status || "complete",
            dependencies: params.dependencies,
          });
        } else if (params.op === "read") {
          if (!params.name?.trim()) throw new Error("lean_artifact read requires a name.");
          result = store.readArtifact(params.name);
          if (!result) throw new Error(`Artifact '${params.name}' was not found.`);
        } else if (params.op === "list") {
          result = store.listArtifacts();
        } else {
          result = store.status();
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { op: params.op, result },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { op: params.op },
          isError: true,
        };
      }
    },
  });

  pi.registerCommand("lean-status", {
    description: "Show durable Lean-OMP tasks, artifacts, and metrics for this project",
    handler: async (_args, ctx) => {
      commandReport(pi, "lean-omp-status", storeFor(ctx).status(), ctx);
    },
  });

  pi.registerCommand("lean-gc", {
    description: "Preview or apply expired Lean-OMP event-journal cleanup (use --apply to delete)",
    handler: async (args, ctx) => {
      const apply = String(args || "").trim() === "--apply";
      commandReport(pi, "lean-omp-gc", storeFor(ctx).pruneEvents({ apply }), ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    safely(ctx, (store) => {
      const retention = store.pruneEvents({ apply: true });
      store.append("session_started", { mode: config.mode, retention });
    });
    ctx.ui.setStatus("lean-omp", `Lean ${config.mode}`);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const status = safely(ctx, (store) => store.status());
    safely(ctx, (store) =>
      store.append("prompt_started", {
        promptTokens: estimateTokens(event.prompt),
        contextTokens: ctx.getContextUsage()?.tokens,
      }),
    );
    if (!status) return;
    return { systemPrompt: [...event.systemPrompt, orchestrationPolicy(config, status)] };
  });

  pi.on("context", async (event, ctx) => {
    const now = Date.now();
    const tokens = estimateTokens(event.messages);
    if (now - lastContextSampleAt >= 30_000 || Math.abs(tokens - lastContextTokens) >= 5_000) {
      lastContextSampleAt = now;
      lastContextTokens = tokens;
      safely(ctx, (store) => store.append("context_sample", { tokens, messages: event.messages.length }));
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "task") {
      const analysis = analyzeTaskInput(event.input, config);
      const duplicate = analysis.packets
        .map((packet) => safely(ctx, (store) => store.findRunningDuplicate(packet.hash)))
        .find(Boolean);
      if (analysis.violations.length || duplicate) {
        const reason = duplicate
          ? `Lean-OMP blocked a duplicate task that is already active as tool call ${duplicate.toolCallId}, child ${Number(duplicate.childIndex ?? 0) + 1}. Wait for its automatic result instead of launching it again.`
          : taskBlockReason(analysis);
        safely(ctx, (store) =>
          store.append("task_blocked", {
            toolCallId: event.toolCallId,
            hash: duplicate?.hash || analysis.hash,
            reason,
            analysis,
            observedOnly: !config.enforce,
          }),
        );
        if (config.enforce) return { block: true, reason };
      }
      for (const packet of analysis.packets) {
        safely(ctx, (store) =>
          store.append("task_started", {
            toolCallId: event.toolCallId,
            childIndex: packet.index,
            hash: packet.hash,
            parentHash: analysis.hash,
            analysis: packet,
          }),
        );
      }
      return;
    }

    if (isSnapshotPoll(event.toolName, event.input)) {
      const key = pollingKey(event.toolName, event.input);
      const now = Date.now();
      const previous = safely(ctx, (store) => store.latestPoll(key));
      const elapsed = previous ? now - previous.at : Number.POSITIVE_INFINITY;
      if (elapsed < config.minimumPollIntervalMs) {
        const waitMs = config.minimumPollIntervalMs - elapsed;
        const reason = pollBlockReason(waitMs);
        safely(ctx, (store) =>
          store.append("poll_suppressed", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            key,
            waitMs,
            observedOnly: !config.enforce,
          }),
        );
        if (config.enforce) return { block: true, reason };
      }
      safely(ctx, (store) =>
        store.append("poll_snapshot", { toolCallId: event.toolCallId, toolName: event.toolName, key }),
      );
    }
  });

  pi.on("tool_execution_update", async (event, ctx) => {
    if (event.toolName !== "task") return;
    const details = event.partialResult?.details || event.partialResult;
    const progress = Array.isArray(details?.progress) ? details.progress : [];
    for (const child of progress) {
      const status = child.status;
      const terminal = status === "completed" || status === "failed" || status === "aborted";
      const progressKey = `${resolveSessionId(ctx)}:${event.toolCallId}:${Number(child.index || 0)}`;
      const now = Date.now();
      if (terminal) {
        if (terminalProgress.has(progressKey)) continue;
        terminalProgress.add(progressKey);
      } else {
        const previous = lastTaskHeartbeat.get(progressKey) || 0;
        if (now - previous < config.taskHeartbeatIntervalMs) continue;
        lastTaskHeartbeat.set(progressKey, now);
      }
      safely(ctx, (store) =>
        store.append(terminal ? "task_finished" : "task_heartbeat", {
          toolCallId: event.toolCallId,
          childIndex: Number(child.index || 0),
          ...(terminal ? { isError: status !== "completed" } : {}),
          progress: {
            status,
            currentTool: child.currentTool,
            toolCount: child.toolCount,
            requests: child.requests,
            tokens: child.tokens,
          },
        }),
      );
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "task") {
      const results = Array.isArray(event.details?.results) ? event.details.results : [];
      if (results.length) {
        for (const result of results) {
          safely(ctx, (store) =>
            store.append("task_finished", {
              toolCallId: event.toolCallId,
              childIndex: Number(result.index || 0),
              agent: result.agent,
              isError: Boolean(result.exitCode || result.error || result.aborted),
              result: redactCheckpoint(result.output || result.stderr || result.error, config.maxCheckpointBytes),
              durationMs: result.durationMs,
              requests: result.requests,
              tokens: result.tokens,
            }),
          );
        }
      } else if (event.isError) {
        const analysis = analyzeTaskInput(event.input, config);
        for (const packet of analysis.packets) {
          safely(ctx, (store) =>
            store.append("task_finished", {
              toolCallId: event.toolCallId,
              childIndex: packet.index,
              isError: true,
              result: redactCheckpoint(resultText(event), config.maxCheckpointBytes),
            }),
          );
        }
      } else {
        safely(ctx, (store) =>
          store.append("task_result_incomplete", {
            toolCallId: event.toolCallId,
            reason: "OMP returned no per-child result details; tasks remain active until liveness proves interruption.",
          }),
        );
      }
    }
    if (event.toolName !== "lean_artifact") {
      safely(ctx, (store) =>
        store.append("tool_checkpoint", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: Boolean(event.isError),
          result: redactCheckpoint(resultText(event, config.maxCheckpointBytes * 2), config.maxCheckpointBytes),
        }),
      );
    }
    if (event.isError) {
      safely(ctx, (store) =>
        store.append("tool_error", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: resultText(event, 1_000),
        }),
      );
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    safely(ctx, (store) =>
      store.append("agent_end", {
        willContinue: Boolean(event.willContinue),
        contextTokens: ctx.getContextUsage()?.tokens,
      }),
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    safely(ctx, (store) => store.append("session_shutdown"));
    lastTaskHeartbeat.clear();
    terminalProgress.clear();
    ctx.ui.setStatus("lean-omp", undefined);
  });
}
