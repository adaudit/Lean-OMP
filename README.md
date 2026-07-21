# Lean-OMP

Lean-OMP is an update-safe OMP extension for Orca-hosted development sessions. It keeps OMP's native agents and scheduler, then adds bounded delegation packets, per-child task tracking, liveness-aware recovery, compact artifacts, committed tool checkpoints, duplicate-task prevention, polling suppression, and local telemetry.

It does **not** patch OMP, Orca, or Intent. An OMP or Orca update cannot overwrite this repository.

## Scope

Lean-OMP is active by default only when Orca environment markers such as `ORCA_PANE_KEY` or `ORCA_AGENT_HOOK_ENDPOINT` are present. A normal terminal OMP session remains unchanged, and Intent does not load OMP plugins.

The extension uses only the public OMP extension API available in OMP 17:

- lifecycle hooks (`session_start`, `before_agent_start`, `context`, `agent_end`)
- tool interception (`tool_call`, `tool_execution_update`, `tool_result`)
- a custom `lean_artifact` tool
- `/lean-doctor` and `/lean-status` commands

## Install

From a normal terminal:

```bash
git clone https://github.com/adaudit/Lean-OMP.git ~/Developer/Lean-OMP
cd ~/Developer/Lean-OMP
npm test
npm run doctor
npm run test:integration
omp plugin link ~/Developer/Lean-OMP --scope user
omp plugin doctor
```

The linked repository remains the source of truth. No files are copied into the OMP installation.

Existing OMP sessions continue with the extension set they loaded at startup. Open a new Orca OMP terminal, or use OMP's plugin reload command when it is safe, to activate a newly linked version.

## Behaviour

### Bounded delegation

Before OMP executes `task`, Lean-OMP estimates the largest child packet. In enforcement mode it blocks:

- a packet over 40,000 estimated tokens
- an individual task body over 28,000 estimated tokens
- shared batch context over 12,000 estimated tokens
- more than six tasks in one call
- an exact duplicate task already active in any worktree sharing the same Git common directory

The error tells the coordinator to pass only the objective, scope, relevant paths/symbols, dependency artifacts, deliverable, and acceptance criteria.

### Durable artifacts

Agents use the `lean_artifact` tool:

```json
{
  "op": "write",
  "name": "backend-route-trace",
  "summary": "Confirmed the UI route reaches handlers/funnel.go:214.",
  "evidence": ["frontend/routes.ts:81", "backend/handlers/funnel.go:214"],
  "status": "complete",
  "dependencies": []
}
```

Supported operations are `write`, `read`, `list`, and `status`. Every write creates an immutable version rather than overwriting an earlier result.

### Recovery state and worktrees

State is stored outside project repositories:

```text
~/.omp/lean-omp/<project-hash>/
├── events/       # per-process, rotating JSONL journals
└── artifacts/    # immutable, versioned artifacts
```

The project hash comes from Git's common directory, so a repository and all of its worktrees share recovery state. `LEAN_OMP_PROJECT_KEY` supplies an explicit identity for non-Git multi-folder projects.

Each process appends only to its own journal, avoiding a shared writable JSON document. Critical task transitions are flushed with `fsync`; a crash-truncated final line is ignored without losing earlier committed lines. Journals rotate at 2 MiB and expire after 30 days. `/lean-gc` previews cleanup and `/lean-gc --apply` performs it; session startup also removes expired event journals. Artifacts are retained until explicitly removed.

Task state is liveness-aware:

- OMP progress updates heartbeat each batch child independently.
- terminal asynchronous progress marks that child complete, failed, or aborted.
- an old task whose process is still alive becomes `stale` and remains duplicate-protected.
- a task whose process died or shut down becomes `interrupted` and can be deliberately resumed.

This prevents a long legitimate run from being mistaken for a safe retry merely because a timer elapsed.

### Committed-step checkpoints

Every completed OMP tool result (success or failure) records a bounded local checkpoint. Common GitHub, OpenAI, Google, password, token, API-key, secret, and Authorization patterns are redacted before persistence. These checkpoints let the next coordinator reconstruct completed tool steps even if a later provider stream fails.

The boundary is explicit: Lean-OMP can preserve only events OMP has committed to `tool_result`. It cannot reconstruct provider tokens that never arrived, prove an uncommitted external side effect, or safely replay an uncertain write. Durable high-value findings should still be written with `lean_artifact`.

### Polling control

OMP background task results auto-deliver. Lean-OMP suppresses repeated `hub jobs` (and legacy `job` status) snapshots inside a 15-second window. Blocking `hub wait` remains available when the coordinator is genuinely unable to progress.

### Compatibility gating

If OMP removes a required public capability, Lean-OMP makes no registration calls, disables itself, and OMP continues normally. The release doctor accepts only verified OMP major 17 by default; a future major fails validation until it is tested. `LEAN_OMP_ALLOW_FUTURE_MAJOR=1` is an explicit, warning-level override for canaries.

## Commands

- `/lean-doctor` — activation, API compatibility, and configured limits
- `/lean-status` — durable task state, artifacts, and metrics for the current project
- `/lean-gc` — preview expired event-journal cleanup
- `/lean-gc --apply` — delete expired event journals (never artifacts or the active journal)

## Configuration

Environment variables are optional:

| Variable | Default | Meaning |
|---|---:|---|
| `LEAN_OMP_MODE` | `enforce` in Orca, `off` elsewhere | `off`, `observe`, or `enforce` |
| `LEAN_OMP_MAX_TASK_PACKET_TOKENS` | `40000` | Maximum estimated per-agent packet |
| `LEAN_OMP_MAX_TASK_BODY_TOKENS` | `28000` | Maximum task-specific body |
| `LEAN_OMP_MAX_SHARED_CONTEXT_TOKENS` | `12000` | Maximum batch shared context |
| `LEAN_OMP_MAX_TASKS_PER_CALL` | `6` | Maximum batch fan-out |
| `LEAN_OMP_MIN_POLL_INTERVAL_MS` | `15000` | Repeated snapshot suppression window |
| `LEAN_OMP_TASK_HEARTBEAT_INTERVAL_MS` | `15000` | Minimum persisted heartbeat interval per child |
| `LEAN_OMP_STALE_TASK_MS` | `1800000` | Live task running-to-stale threshold |
| `LEAN_OMP_MAX_ARTIFACT_BYTES` | `131072` | Maximum one artifact version |
| `LEAN_OMP_MAX_CHECKPOINT_BYTES` | `16384` | Maximum committed tool-result checkpoint |
| `LEAN_OMP_MAX_JOURNAL_BYTES` | `2097152` | Per-process journal rotation size |
| `LEAN_OMP_EVENT_RETENTION_MS` | `2592000000` | Event-journal retention (30 days) |
| `LEAN_OMP_EVENT_READ_LIMIT` | `20000` | Maximum recent telemetry events reduced into status; older task lifecycle records are always preserved |
| `LEAN_OMP_PROJECT_KEY` | unset | Explicit shared identity for non-Git projects |
| `LEAN_OMP_STATE_ROOT` | `~/.omp/lean-omp` | Durable state location |

Use `LEAN_OMP_MODE=observe` for a canary that records violations without blocking them.

## Updating and rollback

```bash
cd ~/Developer/Lean-OMP
git pull --ff-only
npm test
npm run doctor
npm run test:integration
```

To disable immediately for newly opened sessions:

```bash
export LEAN_OMP_MODE=off
```

To unlink it:

```bash
omp plugin uninstall @adaudit/lean-omp --scope user
```

The durable state is deliberately retained during disable/uninstall. Remove it separately only after confirming it is no longer needed.

## Security and dependencies

Lean-OMP has zero runtime and development package dependencies. The repository commits a dependency-free lockfile, sets npm `ignore-scripts=true`, pins GitHub Actions to immutable commits, runs OSV-Scanner on pushes and weekly, runs Dependency Review on pull requests, and enables Dependabot for any future additions. Before accepting a new package, inspect it with Socket CLI as well as the automated OSV and GitHub checks.

## Production guarantees and residual risks

| Area | Guarantee | Residual risk |
|---|---|---|
| Updates | Public extension API only; no OMP, Orca, or Intent patching | A future API can change while retaining the same surface; rerun the RPC smoke after every OMP major upgrade |
| Recovery | Critical transitions are flushed; committed tool results are checkpointed | Provider output or side effects that fail before OMP commits a result cannot be recovered automatically |
| Concurrency | Per-process append-only journals avoid shared-writer corruption | Filesystem or disk failure can still prevent persistence; warnings are fail-open to keep OMP usable |
| Secrets | Common credential forms are redacted; state is mode `0700`/`0600` | Pattern redaction cannot identify every proprietary secret format; do not print secrets into tool output |
| Liveness | Dead processes become interrupted; live stale work stays duplicate-protected | PID reuse can conservatively leave old work stale until reconciliation/retention rather than risk a duplicate side effect |
| Storage | 2 MiB rotation and 30-day event cleanup; artifacts are bounded per version | Artifacts are intentionally retained and may require deliberate lifecycle cleanup in very long-lived projects |

## Non-goals

- replacing OMP's task scheduler
- starting agents outside OMP
- altering Orca's application bundle or managed status hooks
- modifying Intent or sharing configuration with it
- automatically retrying operations with uncertain external side effects
