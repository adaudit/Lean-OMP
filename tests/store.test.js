import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { LeanStore, reduceEvents } from "../src/store.js";

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lean-omp-test-"));
  const config = loadConfig({ ORCA_PANE_KEY: "test", LEAN_OMP_STATE_ROOT: root, LEAN_OMP_STALE_TASK_MS: "100" });
  let current = 1_000;
  const store = new LeanStore({
    cwd: path.join(root, "project"),
    config: { ...config, ...overrides.config },
    sessionId: "session-a",
    now: () => current++,
    processId: overrides.processId ?? 4242,
    processInstance: overrides.processInstance ?? "process-a",
    isProcessAlive: overrides.isProcessAlive ?? (() => true),
  });
  return { root, config, store, setTime(value) { current = value; } };
}

test("live long-running tasks become stale but remain duplicate-protected", () => {
  const { store, setTime } = fixture();
  store.append("task_started", { toolCallId: "one", hash: "h1" });
  store.append("task_finished", { toolCallId: "one", isError: false, result: "done" });
  store.append("task_started", { toolCallId: "two", hash: "h2" });

  const reduced = reduceEvents(store.events(), {
    now: 2_000,
    staleTaskMs: 100,
    isProcessAlive: () => true,
  });
  assert.equal(reduced.tasks.find((task) => task.toolCallId === "one").status, "completed");
  assert.equal(reduced.tasks.find((task) => task.toolCallId === "two").status, "stale");
  setTime(2_000);
  assert.equal(store.findRunningDuplicate("h2").toolCallId, "two");
});

test("dead processes and clean shutdowns interrupt unfinished tasks", () => {
  const dead = reduceEvents(
    [{ type: "task_started", at: 1_000, sessionId: "s", processId: 99, processInstance: "p", toolCallId: "one" }],
    { now: 1_001, staleTaskMs: 100, isProcessAlive: () => false },
  );
  assert.equal(dead.tasks[0].status, "interrupted");

  const shutdown = reduceEvents(
    [
      { type: "task_started", at: 1_000, sessionId: "s", processId: 99, processInstance: "p", toolCallId: "two" },
      { type: "session_shutdown", at: 1_001, sessionId: "s", processId: 99, processInstance: "p" },
    ],
    { now: 1_002, staleTaskMs: 100, isProcessAlive: () => true },
  );
  assert.equal(shutdown.tasks[0].status, "interrupted");
});

test("heartbeats keep active tasks running", () => {
  const reduced = reduceEvents(
    [
      { type: "task_started", at: 1_000, sessionId: "s", processId: 99, processInstance: "p", toolCallId: "one" },
      { type: "task_heartbeat", at: 1_950, sessionId: "s", processId: 99, processInstance: "p", toolCallId: "one" },
    ],
    { now: 2_000, staleTaskMs: 100, isProcessAlive: () => true },
  );
  assert.equal(reduced.tasks[0].status, "running");
});

test("artifact versions are immutable and latest is recoverable", () => {
  const { store } = fixture();
  const first = store.writeArtifact({ name: "Backend Trace", summary: "first" });
  const second = store.writeArtifact({ name: "Backend Trace", summary: "second" });
  assert.notEqual(first.file, second.file);
  assert.equal(fs.existsSync(first.file), true);
  assert.equal(store.readArtifact("backend-trace").summary, "second");
  assert.equal(store.listArtifacts()[0].file, second.file);
});

test("artifact traversal names and oversized payloads are rejected", () => {
  const { store } = fixture();
  assert.throws(() => store.writeArtifact({ name: "../", summary: "bad" }), /must contain/);
  store.config = { ...store.config, maxArtifactBytes: 100 };
  assert.throws(() => store.writeArtifact({ name: "large", summary: "x".repeat(1_000) }), /maximum/);
});

test("events use bounded append-only journals instead of one file per event", () => {
  const { store } = fixture({ config: { maxJournalBytes: 2_000 } });
  for (let index = 0; index < 100; index += 1) store.append("agent_end", { index });
  assert.equal(store.events().length, 100);
  const journals = fs.readdirSync(store.eventsDirectory).filter((name) => name.endsWith(".jsonl"));
  assert.ok(journals.length < 25);
});

test("independent process journals combine without corruption", () => {
  const { root, config, store } = fixture();
  const second = new LeanStore({
    cwd: store.cwd,
    config,
    sessionId: "session-b",
    processId: 5252,
    processInstance: "process-b",
    isProcessAlive: () => true,
  });
  for (let index = 0; index < 50; index += 1) {
    store.append("context_sample", { index });
    second.append("context_sample", { index });
  }
  assert.equal(new LeanStore({ cwd: store.cwd, config, sessionId: "reader" }).events().length, 100);
  assert.equal(fs.readdirSync(path.join(root, store.projectId, "events")).filter((name) => name.endsWith(".jsonl")).length, 2);
});

test("event cleanup is dry-run by default and never removes the active journal", () => {
  const { store } = fixture();
  store.append("agent_end");
  const expired = path.join(store.eventsDirectory, "expired-000000.jsonl");
  fs.writeFileSync(expired, `${JSON.stringify({ type: "agent_end", at: 1 })}\n`);
  fs.utimesSync(expired, new Date(0), new Date(0));
  assert.equal(store.pruneEvents({ before: Date.now() }).files, 1);
  assert.equal(fs.existsSync(expired), true);
  assert.equal(store.pruneEvents({ before: Date.now(), apply: true }).files, 1);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(store.journalPath()), true);
});

test("event cleanup preserves another live process journal", () => {
  const { store } = fixture({ isProcessAlive: (pid) => pid === 7777 });
  const live = path.join(store.eventsDirectory, "other-live-000000.jsonl");
  fs.writeFileSync(live, `${JSON.stringify({ type: "context_sample", at: 1, processId: 7777, processInstance: "live" })}\n`);
  fs.utimesSync(live, new Date(0), new Date(0));
  assert.equal(store.pruneEvents({ before: Date.now(), apply: true }).files, 0);
  assert.equal(fs.existsSync(live), true);
});

test("malformed trailing journal data is ignored while committed lines survive", () => {
  const { store } = fixture();
  store.append("agent_end", { marker: "committed" });
  fs.appendFileSync(store.journalPath(), "{partial");
  assert.equal(store.events().some((event) => event.marker === "committed"), true);
});

test("legacy atomic JSON events remain readable after the journal migration", () => {
  const { store } = fixture();
  fs.writeFileSync(
    path.join(store.eventsDirectory, "0000000000000001-legacy.json"),
    JSON.stringify({ type: "agent_end", at: 1, marker: "legacy" }),
  );
  assert.equal(store.events().some((event) => event.marker === "legacy"), true);
});

test("read limits never discard older task lifecycle state", () => {
  const { store } = fixture({ config: { eventReadLimit: 2 } });
  store.append("task_started", { toolCallId: "long", childIndex: 0, hash: "still-active" });
  store.append("context_sample", { tokens: 1 });
  store.append("context_sample", { tokens: 2 });
  store.append("context_sample", { tokens: 3 });
  assert.equal(store.events().some((event) => event.type === "task_started"), true);
  assert.equal(store.findRunningDuplicate("still-active").toolCallId, "long");
});

test("git worktrees share one project identity and artifact store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lean-omp-worktree-"));
  const repo = path.join(root, "repo");
  const child = path.join(root, "child");
  fs.mkdirSync(repo);
  const git = (args, cwd = repo) => spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.com"]).status, 0);
  assert.equal(git(["config", "user.name", "Lean Test"]).status, 0);
  fs.writeFileSync(path.join(repo, "README.md"), "test\n");
  assert.equal(git(["add", "README.md"]).status, 0);
  assert.equal(git(["commit", "-qm", "initial"]).status, 0);
  assert.equal(git(["worktree", "add", "-q", "-b", "child", child]).status, 0);
  const config = loadConfig({ ORCA_PANE_KEY: "test", LEAN_OMP_STATE_ROOT: path.join(root, "state") });
  const first = new LeanStore({ cwd: repo, config, sessionId: "a" });
  const second = new LeanStore({ cwd: child, config, sessionId: "b" });
  assert.equal(first.projectId, second.projectId);
  first.writeArtifact({ name: "shared", summary: "available to child" });
  assert.equal(second.readArtifact("shared").summary, "available to child");
});
