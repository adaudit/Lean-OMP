import assert from "node:assert/strict";
import test from "node:test";
import { detectOrcaEnvironment, loadConfig } from "../src/config.js";

test("detects Orca without affecting ordinary OMP sessions", () => {
  assert.equal(detectOrcaEnvironment({}), false);
  assert.equal(detectOrcaEnvironment({ ORCA_PANE_KEY: "pane-1" }), true);
  assert.equal(loadConfig({}).mode, "off");
  assert.equal(loadConfig({ ORCA_PANE_KEY: "pane-1" }).mode, "enforce");
});

test("explicit mode overrides environment detection", () => {
  assert.equal(loadConfig({ ORCA_PANE_KEY: "pane-1", LEAN_OMP_MODE: "observe" }).mode, "observe");
  assert.equal(loadConfig({ ORCA_PANE_KEY: "pane-1", LEAN_OMP_MODE: "off" }).active, false);
});

test("invalid numeric overrides fall back safely", () => {
  const config = loadConfig({ ORCA_PANE_KEY: "pane-1", LEAN_OMP_MAX_TASKS_PER_CALL: "nope" });
  assert.equal(config.maxTasksPerCall, 6);
});

test("loads bounded journal, checkpoint, and retention defaults", () => {
  const config = loadConfig({ ORCA_PANE_KEY: "pane-1" });
  assert.ok(config.maxCheckpointBytes >= 8 * 1024);
  assert.ok(config.maxJournalBytes >= 512 * 1024);
  assert.ok(config.eventRetentionMs >= 7 * 24 * 60 * 60 * 1000);
  assert.ok(config.eventReadLimit >= 10_000);
  assert.ok(config.taskHeartbeatIntervalMs >= 5_000);
});
