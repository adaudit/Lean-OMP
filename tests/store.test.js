import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { LeanStore, reduceEvents } from "../src/store.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lean-omp-test-"));
  const config = loadConfig({ ORCA_PANE_KEY: "test", LEAN_OMP_STATE_ROOT: root, LEAN_OMP_STALE_TASK_MS: "100" });
  let current = 1_000;
  const store = new LeanStore({ cwd: path.join(root, "project"), config, sessionId: "session-a", now: () => current++ });
  return { root, config, store, setTime(value) { current = value; } };
}

test("append-only events reconstruct completed and interrupted task state", () => {
  const { store, setTime } = fixture();
  store.append("task_started", { toolCallId: "one", hash: "h1" });
  store.append("task_finished", { toolCallId: "one", isError: false, result: "done" });
  store.append("task_started", { toolCallId: "two", hash: "h2" });

  const reduced = reduceEvents(store.events(), { now: 2_000, staleTaskMs: 100 });
  assert.equal(reduced.tasks.find((task) => task.toolCallId === "one").status, "completed");
  assert.equal(reduced.tasks.find((task) => task.toolCallId === "two").status, "interrupted");
  setTime(2_000);
  assert.equal(store.findRunningDuplicate("h2"), undefined);
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

test("concurrent-style writes produce separate event files", () => {
  const { store } = fixture();
  for (let index = 0; index < 25; index += 1) store.append("agent_end", { index });
  assert.equal(store.events().length, 25);
  assert.equal(new Set(fs.readdirSync(store.eventsDirectory)).size, 25);
});
