import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { analyzeTaskInput } from "../src/task-policy.js";

const config = loadConfig({
  ORCA_PANE_KEY: "test",
  LEAN_OMP_MAX_TASK_PACKET_TOKENS: "100",
  LEAN_OMP_MAX_TASK_BODY_TOKENS: "80",
  LEAN_OMP_MAX_SHARED_CONTEXT_TOKENS: "30",
  LEAN_OMP_MAX_TASKS_PER_CALL: "2",
});

test("accepts a bounded flat task and gives it a stable identity", () => {
  const input = { agent: "explore", task: "Inspect src/auth.js and report the relevant function." };
  const first = analyzeTaskInput(input, config);
  const second = analyzeTaskInput({ task: input.task, agent: "explore" }, config);
  assert.deepEqual(first.violations, []);
  assert.equal(first.hash, second.hash);
  assert.equal(first.taskCount, 1);
});

test("blocks oversized shared context and per-agent packets", () => {
  const analysis = analyzeTaskInput(
    {
      context: "x".repeat(200),
      tasks: [
        { agent: "task", task: "y".repeat(300) },
        { agent: "task", task: "small" },
        { agent: "task", task: "third" },
      ],
    },
    config,
  );
  assert.ok(analysis.violations.some((value) => value.includes("Shared task context")));
  assert.ok(analysis.violations.some((value) => value.includes("Task batch contains")));
  assert.ok(analysis.violations.some((value) => value.includes("packet")));
});

test("rejects an empty task body", () => {
  const analysis = analyzeTaskInput({ agent: "task", task: "   " }, config);
  assert.ok(analysis.violations.some((value) => value.includes("no task body")));
});
