#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectOrcaEnvironment, loadConfig } from "../src/config.js";
import { checkOmpCompatibility } from "../src/doctor.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repositoryRoot, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const extensionPaths = manifest?.omp?.extensions || [];
const extensionFiles = extensionPaths.map((entry) => path.resolve(repositoryRoot, entry));
const missingExtensionFiles = extensionFiles.filter((file) => !fs.existsSync(file));

const versionOutput = process.env.LEAN_OMP_DOCTOR_OMP_VERSION
  ? process.env.LEAN_OMP_DOCTOR_OMP_VERSION
  : spawnSync("omp", ["--version"], { encoding: "utf8" });
const rawVersion =
  typeof versionOutput === "string"
    ? versionOutput
    : `${versionOutput.stdout || ""} ${versionOutput.stderr || ""}`.trim();
const compatibility = checkOmpCompatibility(rawVersion);
const config = loadConfig(process.env);

const report = {
  ok: compatibility.compatible && extensionPaths.length > 0 && missingExtensionFiles.length === 0,
  package: manifest.name,
  pluginVersion: manifest.version,
  repositoryRoot,
  manifest: {
    extensionPaths,
    missingExtensionFiles,
  },
  omp: compatibility,
  activation: {
    mode: config.mode,
    orcaDetected: detectOrcaEnvironment(process.env),
    note: config.active
      ? "Lean-OMP enforcement is active for this process."
      : "Lean-OMP is inactive outside Orca unless LEAN_OMP_MODE is explicitly set.",
  },
  dependencyCount: Object.keys({
    ...(manifest.dependencies || {}),
    ...(manifest.optionalDependencies || {}),
    ...(manifest.peerDependencies || {}),
  }).length,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `Lean-OMP ${report.pluginVersion}: ${report.ok ? "PASS" : "FAIL"}`,
      `OMP: ${compatibility.message}`,
      `Extension: ${extensionPaths.join(", ") || "missing manifest entry"}`,
      `Activation: ${report.activation.mode} (Orca detected: ${report.activation.orcaDetected})`,
      `Runtime dependencies: ${report.dependencyCount}`,
      ...(missingExtensionFiles.length
        ? [`Missing extension files: ${missingExtensionFiles.join(", ")}`]
        : []),
    ].join("\n") + "\n",
  );
}

process.exitCode = report.ok ? 0 : 1;
