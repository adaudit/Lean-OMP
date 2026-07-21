# Changelog

## 1.0.0

- Share task and artifact state across Git worktrees using the Git common directory.
- Track every batch child independently through OMP progress and result details.
- Replace timer-only interruption with process liveness, heartbeats, stale duplicate protection, and shutdown detection.
- Replace one-file-per-event storage with rotating per-process JSONL journals, critical-event `fsync`, corrupt-tail tolerance, caching, and retention cleanup.
- Checkpoint every committed tool result with bounded output and common credential redaction.
- Add `/lean-gc`, strict capability gating, future-major doctor gating, and a real model-free OMP RPC smoke test.
- Pin CI actions and add a lockfile, OSV-Scanner, Dependency Review, and existing Dependabot coverage.

## 0.1.0

- Add Orca-scoped OMP extension activation.
- Add bounded native task delegation and duplicate-task protection.
- Add append-only task/event recovery state.
- Add immutable `lean_artifact` versions and status reconstruction.
- Add repeated background-job snapshot suppression.
- Add `/lean-doctor`, `/lean-status`, automated tests, and CI.
