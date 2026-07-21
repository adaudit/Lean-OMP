#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lean-omp-rpc-"));
const omp = process.env.LEAN_OMP_OMP_BINARY || "omp";
const child = spawn(
  omp,
  ["--mode", "rpc", "--no-session", "--no-title", "-e", path.join(root, "src/main.js"), "--cwd", root, "--model", "openai/gpt-5.6-sol"],
  {
    cwd: root,
    env: {
      ...process.env,
      HOME: stateRoot,
      OPENAI_API_KEY: "lean-omp-smoke-placeholder",
      ORCA_PANE_KEY: "lean-omp-rpc-smoke",
      LEAN_OMP_MODE: "enforce",
      LEAN_OMP_STATE_ROOT: stateRoot,
      PI_CODING_AGENT_DIR: path.join(stateRoot, "agent"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

let buffer = "";
let stderr = "";
let commandsVerified = false;
let commandAccepted = false;
let commandExecuted = false;
let settled = false;

function finish(error) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  child.kill("SIGTERM");
  fs.rmSync(stateRoot, { recursive: true, force: true });
  if (error) {
    process.stderr.write(`${error.message}\n${stderr}`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Lean-OMP RPC smoke: PASS (commands registered; /lean-doctor executed without a model turn)\n");
  }
}

function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function handle(frame) {
  if (frame.type === "ready") {
    send({ id: "commands", type: "get_available_commands" });
    return;
  }
  if (frame.type === "response" && frame.id === "commands") {
    const commands = Array.isArray(frame.data) ? frame.data : frame.data?.commands || [];
    const names = commands.map((command) => command.name || command.command || command);
    for (const expected of ["lean-doctor", "lean-status", "lean-gc"]) {
      if (!names.includes(expected)) {
        throw new Error(`RPC command list is missing /${expected}; received ${JSON.stringify(names.slice(-20))}.`);
      }
    }
    commandsVerified = true;
    send({ id: "doctor", type: "prompt", message: "/lean-doctor" });
    return;
  }
  if (frame.type === "response" && frame.id === "doctor") {
    if (!frame.success) throw new Error(`RPC /lean-doctor failed: ${frame.error || "unknown error"}`);
    commandAccepted = true;
  }
  if (frame.type === "prompt_result" && frame.id === "doctor") {
    if (frame.agentInvoked !== false) throw new Error("RPC /lean-doctor unexpectedly invoked a model turn.");
    commandExecuted = true;
  }
  if (commandsVerified && commandAccepted && commandExecuted) finish();
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.on("error", (error) => finish(error));
child.on("exit", (code) => {
  if (!settled) finish(new Error(`OMP RPC exited before verification (code ${code}).`));
});

const timeout = setTimeout(() => finish(new Error("OMP RPC smoke timed out after 15 seconds.")), 15_000);
