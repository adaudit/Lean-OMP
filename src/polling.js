const SNAPSHOT_OPERATIONS = new Set(["jobs", "list", "status", "poll"]);

export function isSnapshotPoll(toolName, input) {
  const normalizedTool = String(toolName || "").toLowerCase();
  const operation = String(input?.op || input?.action || "").toLowerCase();
  if (normalizedTool === "hub") return operation === "jobs";
  if (normalizedTool === "job" || normalizedTool === "jobs") {
    return !operation || SNAPSHOT_OPERATIONS.has(operation);
  }
  return false;
}

export function pollingKey(toolName, input) {
  const operation = String(input?.op || input?.action || "status").toLowerCase();
  const ids = Array.isArray(input?.ids) ? [...input.ids].map(String).sort().join(",") : "all";
  return `${String(toolName).toLowerCase()}:${operation}:${ids}`;
}

export function pollBlockReason(waitMs) {
  return `Lean-OMP suppressed a repeated background-job snapshot. OMP auto-delivers completed task results. Wait ${Math.ceil(waitMs / 1000)} seconds before another snapshot, or use hub wait when genuinely blocked.`;
}
