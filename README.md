# Lean-OMP

Lean-OMP is an update-safe OMP extension for Orca-hosted development sessions. It keeps OMP's native agents and scheduler, then adds bounded delegation packets, append-only recovery state, compact artifacts, duplicate-task prevention, polling suppression, and local telemetry.

It does **not** patch OMP, Orca, or Intent. An OMP or Orca update cannot overwrite this repository.

## Scope

Lean-OMP is active by default only when Orca environment markers such as `ORCA_PANE_KEY` or `ORCA_AGENT_HOOK_ENDPOINT` are present. A normal terminal OMP session remains unchanged, and Intent does not load OMP plugins.

The extension uses only the public OMP extension API available in OMP 17:

- lifecycle hooks (`session_start`, `before_agent_start`, `context`, `agent_end`)
- tool interception (`tool_call`, `tool_result`)
- a custom `lean_artifact` tool
- `/lean-doctor` and `/lean-status` commands

## Install

From a normal terminal:

```bash
git clone https://github.com/adaudit/Lean-OMP.git ~/Developer/Lean-OMP
cd ~/Developer/Lean-OMP
npm test
npm run doctor
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
- an exact duplicate task already running in the same session

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

### Recovery state

State is stored outside project repositories:

```text
~/.omp/lean-omp/<project-hash>/
├── events/       # one atomic file per state transition
└── artifacts/    # immutable, versioned artifacts
```

There is no shared JSON file for concurrent agents to corrupt. If a process dies, the next session reduces the event records into completed, failed, running, and interrupted task state. A running task becomes `interrupted` after the configured stale interval.

### Polling control

OMP background task results auto-deliver. Lean-OMP suppresses repeated `hub jobs` (and legacy `job` status) snapshots inside a 15-second window. Blocking `hub wait` remains available when the coordinator is genuinely unable to progress.

### Fail-open compatibility

If a future OMP version removes a required public capability, Lean-OMP does not patch around it. The extension disables enforcement and OMP continues normally. Run `/lean-doctor` or `npm run doctor` after OMP upgrades.

## Commands

- `/lean-doctor` — activation, API compatibility, and configured limits
- `/lean-status` — durable task state, artifacts, and metrics for the current project

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
| `LEAN_OMP_STALE_TASK_MS` | `1800000` | Running-to-interrupted threshold |
| `LEAN_OMP_MAX_ARTIFACT_BYTES` | `131072` | Maximum one artifact version |
| `LEAN_OMP_STATE_ROOT` | `~/.omp/lean-omp` | Durable state location |

Use `LEAN_OMP_MODE=observe` for a canary that records violations without blocking them.

## Updating and rollback

```bash
cd ~/Developer/Lean-OMP
git pull --ff-only
npm test
npm run doctor
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

Lean-OMP has zero runtime and development package dependencies. The repository sets npm `ignore-scripts=true`, and Dependabot is configured for any future package additions. Before accepting a new package, inspect it with Socket and scan the lockfile with OSV-Scanner.

## Non-goals

- replacing OMP's task scheduler
- starting agents outside OMP
- altering Orca's application bundle or managed status hooks
- modifying Intent or sharing configuration with it
- automatically retrying operations with uncertain external side effects
