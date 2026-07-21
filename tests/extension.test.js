import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import leanOmp from "../src/main.js";

function schema() {
  return { optional() { return this; } };
}

function fakePi() {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  return {
    handlers,
    tools,
    commands,
    logger: { warn() {}, debug() {} },
    zod: {
      object: schema,
      enum: schema,
      string: schema,
      array: schema,
    },
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage() {},
  };
}

function fakeContext(cwd) {
  return {
    cwd,
    sessionManager: { getSessionFile: () => path.join(cwd, "session.jsonl") },
    ui: { setStatus() {}, notify() {} },
    getContextUsage: () => ({ tokens: 100, contextWindow: 200_000, percent: 0.05 }),
  };
}

test("stays inert outside Orca except for the doctor command", () => {
  const saved = { mode: process.env.LEAN_OMP_MODE, pane: process.env.ORCA_PANE_KEY };
  delete process.env.LEAN_OMP_MODE;
  delete process.env.ORCA_PANE_KEY;
  try {
    const pi = fakePi();
    leanOmp(pi);
    assert.equal(pi.commands.has("lean-doctor"), true);
    assert.equal(pi.tools.size, 0);
    assert.equal(pi.handlers.size, 0);
  } finally {
    if (saved.mode === undefined) delete process.env.LEAN_OMP_MODE;
    else process.env.LEAN_OMP_MODE = saved.mode;
    if (saved.pane === undefined) delete process.env.ORCA_PANE_KEY;
    else process.env.ORCA_PANE_KEY = saved.pane;
  }
});

test("fails open without calling any registration API when capabilities are incomplete", () => {
  let called = false;
  assert.doesNotThrow(() => leanOmp({
    on() { called = true; },
    registerCommand() { called = true; },
    logger: { warn() {} },
  }));
  assert.equal(called, false);
});

test("registers Orca-scoped enforcement and durable artifacts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lean-omp-extension-"));
  const saved = {
    mode: process.env.LEAN_OMP_MODE,
    pane: process.env.ORCA_PANE_KEY,
    root: process.env.LEAN_OMP_STATE_ROOT,
    max: process.env.LEAN_OMP_MAX_TASK_BODY_TOKENS,
  };
  process.env.ORCA_PANE_KEY = "test-pane";
  process.env.LEAN_OMP_MODE = "enforce";
  process.env.LEAN_OMP_STATE_ROOT = root;
  process.env.LEAN_OMP_MAX_TASK_BODY_TOKENS = "10";
  try {
    const pi = fakePi();
    const ctx = fakeContext(path.join(root, "project"));
    leanOmp(pi);
    assert.equal(pi.tools.has("lean_artifact"), true);
    assert.equal(pi.commands.has("lean-status"), true);

    const artifactResult = await pi.tools.get("lean_artifact").execute(
      "artifact-1",
      { op: "write", name: "trace", summary: "durable" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(artifactResult.isError, undefined);

    const blocked = await pi.handlers.get("tool_call")(
      { toolName: "task", toolCallId: "task-1", input: { agent: "task", task: "x".repeat(100) } },
      ctx,
    );
    assert.equal(blocked.block, true);

    const promptResult = await pi.handlers.get("before_agent_start")(
      { prompt: "work", systemPrompt: ["base"] },
      ctx,
    );
    assert.equal(promptResult.systemPrompt[0], "base");
    assert.match(promptResult.systemPrompt.at(-1), /Lean-OMP orchestration policy/);

    const taskInput = {
      context: "bounded",
      tasks: [
        { agent: "explore", task: "trace one" },
        { agent: "test-engineer", task: "check two" },
      ],
    };
    await pi.handlers.get("tool_call")(
      { toolName: "task", toolCallId: "batch-1", input: taskInput },
      ctx,
    );
    await pi.handlers.get("tool_execution_update")(
      {
        toolName: "task",
        toolCallId: "batch-1",
        partialResult: { details: { progress: [{ index: 0, status: "running", toolCount: 2 }] } },
      },
      ctx,
    );
    await pi.handlers.get("tool_execution_update")(
      {
        toolName: "task",
        toolCallId: "batch-1",
        partialResult: { details: { progress: [{ index: 0, status: "running", toolCount: 3 }] } },
      },
      ctx,
    );
    await pi.handlers.get("tool_execution_update")(
      {
        toolName: "task",
        toolCallId: "async-1",
        partialResult: {
          details: {
            progress: [{ index: 0, status: "completed", toolCount: 4, requests: 2, tokens: 80 }],
            async: { state: "completed", jobId: "job-1", type: "task" },
          },
        },
      },
      ctx,
    );
    await pi.handlers.get("tool_result")(
      {
        toolName: "task",
        toolCallId: "batch-1",
        input: taskInput,
        content: [{ type: "text", text: "batch done" }],
        details: {
          results: [
            { index: 0, agent: "explore", exitCode: 0, output: "one", durationMs: 10, requests: 1, tokens: 20 },
            { index: 1, agent: "test-engineer", exitCode: 1, output: "", error: "two failed", durationMs: 20, requests: 2, tokens: 30 },
          ],
        },
        isError: false,
      },
      ctx,
    );

    await pi.handlers.get("tool_result")(
      {
        toolName: "bash",
        toolCallId: "bash-1",
        input: { command: "echo safe" },
        content: [{ type: "text", text: "token=ghp_abcdefghijklmnopqrstuvwxyz123456 and done" }],
        isError: false,
      },
      ctx,
    );
    const checkpoint = fs
      .readdirSync(root, { recursive: true })
      .find((entry) => String(entry).endsWith(".jsonl"));
    assert.ok(checkpoint);
    const journal = fs.readFileSync(path.join(root, checkpoint), "utf8");
    assert.match(journal, /tool_checkpoint/);
    assert.doesNotMatch(journal, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
    const events = fs
      .readdirSync(root, { recursive: true })
      .filter((entry) => String(entry).endsWith(".jsonl"))
      .flatMap((entry) => fs.readFileSync(path.join(root, entry), "utf8").trim().split("\n").map(JSON.parse));
    assert.equal(events.filter((event) => event.type === "task_started" && event.toolCallId === "batch-1").length, 2);
    assert.equal(events.filter((event) => event.type === "task_finished" && event.toolCallId === "batch-1").length, 2);
    assert.equal(events.find((event) => event.type === "task_finished" && event.childIndex === 1).isError, true);
    assert.equal(events.filter((event) => event.type === "task_heartbeat" && event.toolCallId === "batch-1" && event.childIndex === 0).length, 1);
    assert.equal(events.some((event) => event.type === "task_finished" && event.toolCallId === "async-1"), true);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      const envName = name === "pane" ? "ORCA_PANE_KEY" : name === "root" ? "LEAN_OMP_STATE_ROOT" : name === "max" ? "LEAN_OMP_MAX_TASK_BODY_TOKENS" : "LEAN_OMP_MODE";
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  }
});
