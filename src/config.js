import os from "node:os";
import path from "node:path";

const MODES = new Set(["off", "observe", "enforce"]);

function positiveInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function detectOrcaEnvironment(env = process.env) {
  return Boolean(
    env.ORCA_PANE_KEY ||
      env.ORCA_WORKTREE_ID ||
      env.ORCA_AGENT_HOOK_ENDPOINT ||
      env.ORCA_AGENT_HOOK_PORT,
  );
}

export function loadConfig(env = process.env) {
  const requestedMode = String(env.LEAN_OMP_MODE || "").toLowerCase();
  const mode = MODES.has(requestedMode)
    ? requestedMode
    : detectOrcaEnvironment(env)
      ? "enforce"
      : "off";

  return Object.freeze({
    mode,
    active: mode !== "off",
    enforce: mode === "enforce",
    orca: detectOrcaEnvironment(env),
    maxTaskPacketTokens: positiveInteger(env.LEAN_OMP_MAX_TASK_PACKET_TOKENS, 40_000),
    maxTaskBodyTokens: positiveInteger(env.LEAN_OMP_MAX_TASK_BODY_TOKENS, 28_000),
    maxSharedContextTokens: positiveInteger(env.LEAN_OMP_MAX_SHARED_CONTEXT_TOKENS, 12_000),
    maxTasksPerCall: positiveInteger(env.LEAN_OMP_MAX_TASKS_PER_CALL, 6),
    minimumPollIntervalMs: positiveInteger(env.LEAN_OMP_MIN_POLL_INTERVAL_MS, 15_000),
    taskHeartbeatIntervalMs: positiveInteger(env.LEAN_OMP_TASK_HEARTBEAT_INTERVAL_MS, 15_000),
    staleTaskMs: positiveInteger(env.LEAN_OMP_STALE_TASK_MS, 30 * 60 * 1000),
    maxArtifactBytes: positiveInteger(env.LEAN_OMP_MAX_ARTIFACT_BYTES, 128 * 1024),
    maxCheckpointBytes: positiveInteger(env.LEAN_OMP_MAX_CHECKPOINT_BYTES, 16 * 1024),
    maxJournalBytes: positiveInteger(env.LEAN_OMP_MAX_JOURNAL_BYTES, 2 * 1024 * 1024),
    eventRetentionMs: positiveInteger(env.LEAN_OMP_EVENT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000),
    eventReadLimit: positiveInteger(env.LEAN_OMP_EVENT_READ_LIMIT, 20_000),
    projectKey: String(env.LEAN_OMP_PROJECT_KEY || "").trim() || undefined,
    stateRoot: path.resolve(env.LEAN_OMP_STATE_ROOT || path.join(os.homedir(), ".omp", "lean-omp")),
  });
}

export function formatConfig(config) {
  return {
    mode: config.mode,
    orca: config.orca,
    maxTaskPacketTokens: config.maxTaskPacketTokens,
    maxTaskBodyTokens: config.maxTaskBodyTokens,
    maxSharedContextTokens: config.maxSharedContextTokens,
    maxTasksPerCall: config.maxTasksPerCall,
    minimumPollIntervalMs: config.minimumPollIntervalMs,
    taskHeartbeatIntervalMs: config.taskHeartbeatIntervalMs,
    staleTaskMs: config.staleTaskMs,
    maxArtifactBytes: config.maxArtifactBytes,
    maxCheckpointBytes: config.maxCheckpointBytes,
    maxJournalBytes: config.maxJournalBytes,
    eventRetentionMs: config.eventRetentionMs,
    projectKey: config.projectKey,
    stateRoot: config.stateRoot,
  };
}
