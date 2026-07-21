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
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      const envName = name === "pane" ? "ORCA_PANE_KEY" : name === "root" ? "LEAN_OMP_STATE_ROOT" : name === "max" ? "LEAN_OMP_MAX_TASK_BODY_TOKENS" : "LEAN_OMP_MODE";
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  }
});
