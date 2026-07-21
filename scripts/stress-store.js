#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../src/config.js";
import { LeanStore } from "../src/store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lean-omp-stress-"));
try {
  const config = loadConfig({
    ORCA_PANE_KEY: "stress",
    LEAN_OMP_STATE_ROOT: root,
    LEAN_OMP_MAX_JOURNAL_BYTES: String(128 * 1024),
    LEAN_OMP_EVENT_READ_LIMIT: "20000",
  });
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const first = new LeanStore({ cwd: project, config, sessionId: "first", processInstance: "stress-a" });
  const second = new LeanStore({ cwd: project, config, sessionId: "second", processInstance: "stress-b" });
  const started = performance.now();
  for (let index = 0; index < 10_000; index += 1) {
    (index % 2 === 0 ? first : second).append("context_sample", { index, tokens: index * 10 });
  }
  const events = first.events();
  const elapsedMs = Math.round(performance.now() - started);
  const journals = fs.readdirSync(first.eventsDirectory).filter((file) => file.endsWith(".jsonl"));
  assert.equal(events.length, 10_000);
  assert.ok(journals.length < 100, `Expected fewer than 100 journals, got ${journals.length}.`);
  assert.equal(events[0].index, 0);
  assert.equal(events.at(-1).index, 9_999);
  process.stdout.write(`Lean-OMP store stress: PASS (10,000 events, ${journals.length} journals, ${elapsedMs} ms)\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
