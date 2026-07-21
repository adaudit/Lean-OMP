import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { digest } from "./tokens.js";

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
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

function atomicWrite(directory, fileName, contents) {
  ensureDirectory(directory);
  const destination = path.join(directory, fileName);
  const temporary = `${destination}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, destination);
  return destination;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function taskKey(event) {
  return `${event.sessionId || "unknown"}:${event.toolCallId || event.hash || "unknown"}`;
}

export function reduceEvents(events, { now = Date.now(), staleTaskMs = 30 * 60 * 1000 } = {}) {
  const tasks = new Map();
  const metrics = {
    taskStarted: 0,
    taskFinished: 0,
    taskBlocked: 0,
    pollSuppressed: 0,
    toolErrors: 0,
    agentEnds: 0,
  };

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.type === "task_started") {
      metrics.taskStarted += 1;
      tasks.set(taskKey(event), { ...event, status: "running" });
    } else if (event.type === "task_finished") {
      metrics.taskFinished += 1;
      const key = taskKey(event);
      const previous = tasks.get(key) || {};
      tasks.set(key, { ...previous, ...event, status: event.isError ? "failed" : "completed" });
    } else if (event.type === "task_blocked") {
      metrics.taskBlocked += 1;
    } else if (event.type === "poll_suppressed") {
      metrics.pollSuppressed += 1;
    } else if (event.type === "tool_error") {
      metrics.toolErrors += 1;
    } else if (event.type === "agent_end") {
      metrics.agentEnds += 1;
    }
  }

  for (const task of tasks.values()) {
    if (task.status === "running" && now - Number(task.at || 0) > staleTaskMs) {
      task.status = "interrupted";
    }
  }

  return { tasks: [...tasks.values()], metrics };
}

export class LeanStore {
  constructor({ cwd, config, sessionId = "unknown", now = () => Date.now() }) {
    this.cwd = path.resolve(cwd);
    this.config = config;
    this.sessionId = sessionId;
    this.now = now;
    this.projectId = digest(this.cwd, 24);
    this.root = path.join(config.stateRoot, this.projectId);
    this.eventsDirectory = path.join(this.root, "events");
    this.artifactsDirectory = path.join(this.root, "artifacts");
  }

  append(type, data = {}) {
    const at = this.now();
    const event = {
      version: 1,
      type,
      at,
      sessionId: this.sessionId,
      cwd: this.cwd,
      ...data,
    };
    atomicWrite(this.eventsDirectory, uniqueFileName(at), `${JSON.stringify(event)}\n`);
    return event;
  }

  events() {
    if (!fs.existsSync(this.eventsDirectory)) return [];
    const files = fs
      .readdirSync(this.eventsDirectory)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .slice(-this.config.eventReadLimit);
    return files.map((file) => readJson(path.join(this.eventsDirectory, file))).filter(Boolean);
  }

  status() {
    const reduced = reduceEvents(this.events(), {
      now: this.now(),
      staleTaskMs: this.config.staleTaskMs,
    });
    const taskCounts = reduced.tasks.reduce(
      (counts, task) => {
        counts[task.status] = (counts[task.status] || 0) + 1;
        return counts;
      },
      {},
    );
    return {
      projectId: this.projectId,
      cwd: this.cwd,
      stateRoot: this.root,
      taskCounts,
      tasks: reduced.tasks,
      artifacts: this.listArtifacts(),
      metrics: reduced.metrics,
    };
  }

  findRunningDuplicate(hash) {
    const { tasks } = reduceEvents(this.events(), {
      now: this.now(),
      staleTaskMs: this.config.staleTaskMs,
    });
    return tasks.find(
      (task) => task.sessionId === this.sessionId && task.hash === hash && task.status === "running",
    );
  }

  latestPoll(key) {
    return [...this.events()]
      .reverse()
      .find((event) => event.type === "poll_snapshot" && event.sessionId === this.sessionId && event.key === key);
  }

  writeArtifact({ name, summary, evidence = [], status = "complete", dependencies = [] }) {
    const artifactName = safeName(name);
    const record = {
      version: 1,
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
    const file = atomicWrite(directory, uniqueFileName(this.now()), contents);
    this.append("artifact_written", { name: artifactName, file, bytes, status });
    return { ...record, file, bytes };
  }

  readArtifact(name) {
    const artifactName = safeName(name);
    const directory = path.join(this.artifactsDirectory, artifactName);
    if (!fs.existsSync(directory)) return undefined;
    const file = fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .at(-1);
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
