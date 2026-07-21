import { digest, estimateTokens } from "./tokens.js";

function text(value) {
  return typeof value === "string" ? value : "";
}

function schemaTokens(item) {
  return estimateTokens(item?.outputSchema);
}

export function analyzeTaskInput(input, config) {
  const violations = [];
  const batch = Array.isArray(input?.tasks);
  const tasks = batch ? input.tasks : [input];
  const sharedContextTokens = batch ? estimateTokens(text(input?.context)) : 0;

  if (tasks.length > config.maxTasksPerCall) {
    violations.push(
      `Task batch contains ${tasks.length} items; the configured maximum is ${config.maxTasksPerCall}.`,
    );
  }
  if (sharedContextTokens > config.maxSharedContextTokens) {
    violations.push(
      `Shared task context is approximately ${sharedContextTokens} tokens; the configured maximum is ${config.maxSharedContextTokens}. Put large evidence in a Lean-OMP artifact and reference it.`,
    );
  }

  const packets = tasks.map((item, index) => {
    const bodyTokens = estimateTokens(text(item?.task)) + schemaTokens(item);
    const packetTokens = sharedContextTokens + bodyTokens;
    if (!text(item?.task).trim()) {
      violations.push(`Task ${index + 1} has no task body.`);
    }
    if (bodyTokens > config.maxTaskBodyTokens) {
      violations.push(
        `Task ${index + 1} body is approximately ${bodyTokens} tokens; the configured maximum is ${config.maxTaskBodyTokens}.`,
      );
    }
    if (packetTokens > config.maxTaskPacketTokens) {
      violations.push(
        `Task ${index + 1} packet is approximately ${packetTokens} tokens; the configured maximum is ${config.maxTaskPacketTokens}.`,
      );
    }
    const identity = {
      context: batch ? text(input?.context).trim() : undefined,
      agent: text(item?.agent) || "task",
      task: text(item?.task).trim(),
      outputSchema: item?.outputSchema,
      schemaMode: item?.schemaMode,
      isolated: item?.isolated,
    };
    return {
      index,
      agent: text(item?.agent) || "task",
      name: text(item?.name),
      hash: digest(identity),
      bodyTokens,
      packetTokens,
    };
  });

  return {
    hash: digest(packets.map((packet) => packet.hash)),
    batch,
    taskCount: tasks.length,
    sharedContextTokens,
    totalDeclaredTokens: sharedContextTokens + packets.reduce((sum, packet) => sum + packet.bodyTokens, 0),
    maximumPacketTokens: packets.reduce((maximum, packet) => Math.max(maximum, packet.packetTokens), 0),
    packets,
    violations,
  };
}

export function taskBlockReason(analysis) {
  return [
    "Lean-OMP blocked this delegation because the task packet exceeds its reliability budget:",
    ...analysis.violations.map((violation) => `- ${violation}`),
    "Retry with only the objective, bounded scope, relevant paths, required dependency artifacts, deliverable, and acceptance criteria.",
  ].join("\n");
}
