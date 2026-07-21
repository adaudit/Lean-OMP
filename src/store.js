import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { digest } from "./tokens.js";

const DURABLE_EVENT_TYPES = new Set([
  "session_started",
  "session_shutdown",
  "task_started",
  "task_finished",
  "task_blocked",
  "artifact_written",
]);
const TASK_LIFECYCLE_TYPES = new Set([
  "task_started",
  "task_heartbeat",
  "task_finished",
  "task_result_incomplete",
  "session_shutdown",
]);

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Existing directories can be read-only in diagnostic environments.
  }
}

function safeName(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error("Artifact names must contain at least one letter or number.");
  }
  return normalized;
}

function uniqueFileName(timestamp, suffix = "json") {
  const random = crypto.randomBytes(6).toString("hex");
  return `${String(timestamp).padStart(16, "0")}-${process.pid}-${random}.${suffix}`;
}

function durableAtomicWrite(directory, fileName, contents) {
  ensureDirectory(directory);
  const destination = path.join(directory, fileName);
  const temporary = `${destination}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, destination);
  try {
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch {
    // Directory fsync is not supported by every filesystem.
  }
  return destination;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveProjectIdentity(cwd, explicitKey) {
  if (explicitKey) return `explicit:${explicitKey}`;
  const root = canonicalPath(cwd);
  const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5_000 });
  let result = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (result.status !== 0) result = run(["rev-parse", "--git-common-dir"]);
  if (result.status === 0 && result.stdout.trim()) {
    return `git:${canonicalPath(path.resolve(root, result.stdout.trim()))}`;
  }
  return `directory:${root}`;
}

function taskKey(event) {
  return `${event.sessionId || "unknown"}:${event.toolCallId || event.hash || "unknown"}:${event.childIndex ?? 0}`;
}

export function reduceEvents(
  events,
  { now = Date.now(), staleTaskMs = 30 * 60 * 1000, isProcessAlive = defaultIsProcessAlive } = {},
) {
  const tasks = new Map();
  const shutdownProcesses = new Set();
  const metrics = {
    taskStarted: 0,
    taskFinished: 0,
    taskBlocked: 0,
    pollSuppressed: 0,
    toolErrors: 0,
    toolCheckpoints: 0,
    agentEnds: 0,
  };

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "task_started") {
      metrics.taskStarted += 1;
      tasks.set(taskKey(event), { ...event, lastHeartbeatAt: event.at, status: "running" });
    } else if (event.type === "task_heartbeat") {
      const key = taskKey(event);
      const previous = tasks.get(key);
      if (previous) tasks.set(key, { ...previous, lastHeartbeatAt: event.at, progress: event.progress });
    } else if (event.type === "task_finished") {
      metrics.taskFinished += 1;
      const key = taskKey(event);
      const previous = tasks.get(key) || {};
      tasks.set(key, { ...previous, ...event, status: event.isError ? "failed" : "completed" });
    } else if (event.type === "session_shutdown") {
      shutdownProcesses.add(`${event.sessionId || "unknown"}:${event.processInstance || "legacy"}`);
    } else if (event.type === "task_blocked") {
      metrics.taskBlocked += 1;
    } else if (event.type === "poll_suppressed") {
      metrics.pollSuppressed += 1;
    } else if (event.type === "tool_error") {
      metrics.toolErrors += 1;
    } else if (event.type === "tool_checkpoint") {
      metrics.toolCheckpoints += 1;
    } else if (event.type === "agent_end") {
      metrics.agentEnds += 1;
    }
  }

  for (const task of tasks.values()) {
    if (task.status !== "running") continue;
    const processKey = `${task.sessionId || "unknown"}:${task.processInstance || "legacy"}`;
    const hasLivenessIdentity = Number.isInteger(task.processId) && Boolean(task.processInstance);
    if (shutdownProcesses.has(processKey) || (hasLivenessIdentity && !isProcessAlive(task.processId))) {
      task.status = "interrupted";
      continue;
    }
    const lastActivity = Number(task.lastHeartbeatAt || task.at || 0);
    if (now - lastActivity > staleTaskMs) {
      task.status = hasLivenessIdentity ? "stale" : "interrupted";
    }
  }

  return { tasks: [...tasks.values()], metrics };
}

export class LeanStore {
  constructor({
    cwd,
    config,
    sessionId = "unknown",
    now = () => Date.now(),
    processId = process.pid,
    processInstance = crypto.randomUUID(),
    isProcessAlive = defaultIsProcessAlive,
  }) {
    this.cwd = canonicalPath(cwd);
    this.config = config;
    this.sessionId = sessionId;
    this.now = now;
    this.processId = processId;
    this.processInstance = processInstance;
    this.isProcessAlive = isProcessAlive;
    this.sequence = 0;
    this.segment = 0;
    this.fileCache = new Map();
    this.projectIdentity = resolveProjectIdentity(this.cwd, config.projectKey);
    this.projectId = digest(this.projectIdentity, 24);
    this.root = path.join(config.stateRoot, this.projectId);
    this.eventsDirectory = path.join(this.root, "events");
    this.artifactsDirectory = path.join(this.root, "artifacts");
    ensureDirectory(this.eventsDirectory);
    ensureDirectory(this.artifactsDirectory);
  }

  journalPath() {
    const safeInstance = this.processInstance.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
    return path.join(this.eventsDirectory, `${safeInstance}-${String(this.segment).padStart(6, "0")}.jsonl`);
  }

  append(type, data = {}) {
    const at = this.now();
    const event = {
      version: 2,
      type,
      at,
      sequence: ++this.sequence,
      sessionId: this.sessionId,
      processId: this.processId,
      processInstance: this.processInstance,
      cwd: this.cwd,
      ...data,
    };
    const line = `${JSON.stringify(event)}\n`;
    let journal = this.journalPath();
    try {
      if (fs.statSync(journal).size + Buffer.byteLength(line) > this.config.maxJournalBytes) {
        this.segment += 1;
        journal = this.journalPath();
      }
    } catch {
      // A missing journal starts the current segment.
    }
    if (DURABLE_EVENT_TYPES.has(type)) {
      const fd = fs.openSync(journal, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeSync(fd, line, undefined, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.appendFileSync(journal, line, { encoding: "utf8", mode: 0o600, flag: "a" });
    }
    this.fileCache.delete(journal);
    return event;
  }

  readJournal(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    const cached = this.fileCache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.events;
    const events = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    this.fileCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, events });
    return events;
  }

  events() {
    if (!fs.existsSync(this.eventsDirectory)) return [];
    const events = [];
    for (const entry of fs.readdirSync(this.eventsDirectory).sort()) {
      const file = path.join(this.eventsDirectory, entry);
      if (entry.endsWith(".jsonl")) events.push(...this.readJournal(file));
      else if (entry.endsWith(".json")) {
        const legacy = readJson(file);
        if (legacy) events.push(legacy);
      }
    }
    const sorted = events.sort(
      (left, right) =>
        Number(left.at || 0) - Number(right.at || 0) ||
        String(left.processInstance || "").localeCompare(String(right.processInstance || "")) ||
        Number(left.sequence || 0) - Number(right.sequence || 0),
    );
    if (sorted.length <= this.config.eventReadLimit) return sorted;
    const boundary = sorted.length - this.config.eventReadLimit;
    const preservedLifecycle = sorted.slice(0, boundary).filter((event) => TASK_LIFECYCLE_TYPES.has(event.type));
    return [...preservedLifecycle, ...sorted.slice(boundary)];
  }

  reduced() {
    return reduceEvents(this.events(), {
      now: this.now(),
      staleTaskMs: this.config.staleTaskMs,
      isProcessAlive: this.isProcessAlive,
    });
  }

  status() {
    const reduced = this.reduced();
    const taskCounts = reduced.tasks.reduce((counts, task) => {
      counts[task.status] = (counts[task.status] || 0) + 1;
      return counts;
    }, {});
    return {
      projectId: this.projectId,
      projectIdentity: this.projectIdentity,
      cwd: this.cwd,
      stateRoot: this.root,
      taskCounts,
      tasks: reduced.tasks,
      artifacts: this.listArtifacts(),
      metrics: reduced.metrics,
    };
  }

  findRunningDuplicate(hash) {
    return this.reduced().tasks.find(
      (task) => task.hash === hash && (task.status === "running" || task.status === "stale"),
    );
  }

  latestPoll(key) {
    return [...this.events()]
      .reverse()
      .find((event) => event.type === "poll_snapshot" && event.sessionId === this.sessionId && event.key === key);
  }

  pruneEvents({ apply = false, before = this.now() - this.config.eventRetentionMs } = {}) {
    const candidates = fs
      .readdirSync(this.eventsDirectory)
      .filter((entry) => entry.endsWith(".jsonl") || entry.endsWith(".json"))
      .map((entry) => path.join(this.eventsDirectory, entry))
      .filter((file) => {
        if (file === this.journalPath()) return false;
        try {
          if (fs.statSync(file).mtimeMs >= before) return false;
          const lastEvent = file.endsWith(".jsonl") ? this.readJournal(file).at(-1) : readJson(file);
          if (Number.isInteger(lastEvent?.processId) && this.isProcessAlive(lastEvent.processId)) {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      });
    let bytes = 0;
    for (const file of candidates) {
      try {
        bytes += fs.statSync(file).size;
        if (apply) {
          fs.unlinkSync(file);
          this.fileCache.delete(file);
        }
      } catch {
        // A concurrent process may already have removed an expired segment.
      }
    }
    return { apply, before: new Date(before).toISOString(), files: candidates.length, bytes };
  }

  writeArtifact({ name, summary, evidence = [], status = "complete", dependencies = [] }) {
    const artifactName = safeName(name);
    const record = {
      version: 2,
      name: artifactName,
      title: String(name).trim(),
      status,
      summary: String(summary || ""),
      evidence: Array.isArray(evidence) ? evidence.map(String) : [],
      dependencies: Array.isArray(dependencies) ? dependencies.map(String) : [],
      createdAt: new Date(this.now()).toISOString(),
      sessionId: this.sessionId,
      cwd: this.cwd,
    };
    const contents = `${JSON.stringify(record, null, 2)}\n`;
    const bytes = Buffer.byteLength(contents, "utf8");
    if (bytes > this.config.maxArtifactBytes) {
      throw new Error(
        `Artifact is ${bytes} bytes; the configured maximum is ${this.config.maxArtifactBytes}. Store large evidence in files and reference paths/ranges.`,
      );
    }
    const directory = path.join(this.artifactsDirectory, artifactName);
    const file = durableAtomicWrite(directory, uniqueFileName(this.now()), contents);
    this.append("artifact_written", { name: artifactName, file, bytes, status });
    return { ...record, file, bytes };
  }

  readArtifact(name) {
    const artifactName = safeName(name);
    const directory = path.join(this.artifactsDirectory, artifactName);
    if (!fs.existsSync(directory)) return undefined;
    const file = fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort().at(-1);
    if (!file) return undefined;
    const fullPath = path.join(directory, file);
    const record = readJson(fullPath);
    return record ? { ...record, file: fullPath } : undefined;
  }

  listArtifacts() {
    if (!fs.existsSync(this.artifactsDirectory)) return [];
    return fs
      .readdirSync(this.artifactsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readArtifact(entry.name))
      .filter(Boolean)
      .map(({ name, title, status, createdAt, sessionId, file }) => ({
        name,
        title,
        status,
        createdAt,
        sessionId,
        file,
      }))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }
}

export function resolveSessionId(ctx, env = process.env) {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (sessionFile) return digest(path.resolve(sessionFile), 24);
  return String(env.ORCA_PANE_KEY || env.ORCA_WORKTREE_ID || `process-${process.pid}`);
}
