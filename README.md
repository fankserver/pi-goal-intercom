# pi-goal-intercom

Start and cancel **pi-goal** managed runs from an **intercom** message, with
status replies sent back to the sender.

A session that receives an intercom message containing a `GOAL:START` marker
starts a *real* `pi-goal` goal (via the `pi-goal:start` Managed Run RPC on the
shared `pi.events` bus), then reports `active` / terminal outcome / rejection
back to the sender over intercom. No shell-out, no typing `/goal`, no second
human needed.

This fills a real gap: pi-goal exposes the managed-run RPC, and pi-intercom
provides inter-session transport, but nothing shipped wires the two together —
an agent cannot start a goal for itself or for a peer, because `/goal` is a
human-typed host command and the agent-facing goal tools
(`goal_complete`/`goal_blocked`/`goal_wait`) all require an *already active*
goal.

## Install

```bash
# from GitHub (tracks the default branch)
pi install git:github.com/fankserver/pi-goal-intercom

# pinned to a tag or commit
pi install git:github.com/fankserver/pi-goal-intercom@v0.1.0

# local checkout
pi install /absolute/path/to/pi-goal-intercom
```

Restart the target Pi session (or `/reload`) so the extension loads. `dist/` is
committed, so a git install needs no build.

## Usage

Any intercom message body that reaches the target session. A command must be the
**first non-empty line of the message body**, unwrapped in code delimiters — a
marker quoted mid-sentence, in backticks, in a blockquote, or in a fence is
prose and is ignored:

```text
GOAL:START <objective> [--tokens <N>]
GOAL:CANCEL [reason]
GOAL:STATUS
```

From a sender session:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "GOAL:START finish README and commit it --tokens 800000",
});
```

Examples:

```text
GOAL:START debug the flaky test in ./internal/policy until it is green --tokens 2000000
GOAL:CANCEL owner changed direction
GOAL:STATUS
```

The sender gets status replies back over intercom, each reporting what pi-goal
actually did rather than what was requested:

```text
▶️ GOAL active: finish README and commit it
✅ GOAL complete: finish README and commit it — <completion summary>
⛔ GOAL blocked: … — <reason>          (also usage/paused/cleared)
💰 GOAL budget_limited: … — token budget reached (1.2M/1M) Recovery: ask a human to run `/goal edit --tokens <higher>`…
🛑 GOAL cancelled: paused — owner changed direction
⚠️ GOAL:CANCEL refused (RUN_NOT_FOUND): … A human must run `/goal clear`…
⚠️ GOAL:START rejected (RPC_DISABLED): Managed run RPC is disabled.
ℹ️ GOAL:STATUS — run pgi-1a2b… / last status: budget_limited / STUCK…
```

## Replay safety

A resume or `/reload` re-presents the **entire** message history to the extension, so
a command that already ran arrives again looking brand new. Commands are therefore
**exactly-once per delivery**: the envelope delivery stamp must not predate this
process, and the delivery id is recorded durably in
`~/.pi/agent/pi-goal-intercom-processed.json` (`PI_GOAL_INTERCOM_STATE_DIR`
overrides). Restarting a session therefore never silently re-runs its last goal.
Dedupe is per **delivery**, not per text: a deliberate retry re-sending the same
objective is a new delivery and does act again, which is what makes a retry
predictable.

## Sizing `--tokens`

The budget is cumulative across the whole goal run, and every model request
re-sends the full conversation with cached prompt input billed. A real turn
cost `input 39,837 + cacheRead 20,096 + output 93 = 60,026` tokens — 60k billed
for 93 tokens of work. Therefore:

```text
cost ≈ turns × contextTokens   →   --tokens ≥ max(150000, planned_turns × contextTokens × 1.3)
```

**Leave it out unless you have a specific reason to cap spend.** `--tokens` is
honoured when you pass it — dropping a ceiling you asked for would run past what you
authorized — but it is not part of the recommended form, because its failure mode is
state damage rather than a clean stop:

- The budget is cumulative **cost**, not work, so it cannot be sized from the
  objective alone.
- Exhausting it leaves a stopped goal holding the slot, which managed cancel cannot
  free; a human must run `/goal edit --tokens` inside that session.
- Below roughly one turn it is strictly negative: one request burned, no work, slot
  jammed. Observed at 40k and 60k against warmed 140k–235k sessions.

So the extension enforces a **floor of 150,000** in code rather than trusting
documentation — an earlier version of this skill recommended sizing budgets, several
coordinators obliged, and four sessions jammed. Anything below the floor is refused
with `BUDGET_TOO_LOW`, and a malformed value (`--tokens abc`, `--tokens 40k`) is
refused too rather than quietly treated as "no budget", which would run unbounded
after you asked for a cap.

Read `contextTokens` from `intercom list` and size for the whole horizon.
`automaticTurns` is unlimited by design; runaway loops are caught by `noProgressTurns`
plus repeated-output fingerprinting, not by a turn cap. For long goals the dominant
lever is context size.

## Recovering a stuck goal slot

pi-goal's managed cancel only pauses a goal that is exactly `active`. A goal in
`budget_limited`, `paused`, `blocked`, or `usage_limited` persists and keeps
rejecting starts, and clearing it is not reachable over the event bus (only
`pi-goal:start` and `pi-goal:cancel` exist). Both need a human in that session:

- Budget exhausted on real work → **`/goal edit --tokens <higher>`**, which raises
  the ceiling and resumes the same goal with objective, cumulative usage, and
  elapsed time intact. **Not `/goal clear`** — that discards the objective and
  every accumulated turn.
- Goal genuinely wrong → `/goal clear`, which is still cheaper than restarting the
  session (a restart also discards the session's context).

Send `GOAL:STATUS` to detect this instead of guessing from `GOAL_ALREADY_EXISTS`.

## Bundled skill (so agents know it exists)

The package ships a skill, `pi-goal-intercom`, declaring the protocol to agents.
Without it the capability is invisible — README/docs are never read by a model,
so a session would not know `GOAL:START` exists.

Pi advertises the skill's name + description at startup and loads the full
instructions when a task matches (delegating autonomous work to a peer session,
"set a goal" for another session, reporting a delegated goal's outcome). Force
it with:

```text
/skill:pi-goal-intercom
```

It documents both sides: sender-side `GOAL:START` / `GOAL:CANCEL` / `GOAL:STATUS`
syntax, the strict command-position rule, budget sizing for long-horizon runs, the
status replies to expect, a failure table (`RPC_DISABLED`, `GOAL_ALREADY_EXISTS`,
silent no-op), stuck-slot recovery, the session-name scope gate, and the things
that **cannot** work (no goal-start tool; `/goal` in a message body is inert).
Restart the session after installing so the skill is discovered.

## Requirements

| Requirement | Why | If missing |
| --- | --- | --- |
| `@narumitw/pi-goal` (or any pi-goal implementing Managed Run RPC v1) | provides `pi-goal:start` / `pi-goal:cancel` | start is logged and rejected back to the sender |
| `pi-goal.json` → `"rpc": { "enabled": true }` | the Managed Run RPC is opt-in for security | starts return `RPC_DISABLED` |
| pi-intercom present in the session | status replies use `intercom:outbox-request` | goal still starts; replies are skipped |
| A session the extension is allowed to act in | scoping, see Safety | fully inert |

## Safety scoping — read this

The extension is **inert unless explicitly allowed**:

- the session's display name starts with `test` (`test-1`, `test-2`, …), **or**
- `PI_GOAL_INTERCOM_ALLOW=1` is set in the target session's environment.

Everywhere else the `context` hook returns immediately, so installing it
globally is safe: a stray `GOAL:START` reaching a non-test session is ignored.

A started goal runs **paid autonomous turns**, and `automaticTurns: null` is the
intended configuration for long-horizon goals — there is no response-count cap,
because legitimate goals may run for weeks. The guards are therefore the
cumulative `--tokens` budget (see *Sizing `--tokens`*) and pi-goal's no-progress
detection. Treat `GOAL:START` as a real instruction and always pass a budget sized
to the whole run. Status replies are feedback, not authorization.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # verify + stage dist/index.ts (committed)
npm run check       # build + smoke test
```

Skills are declared explicitly under `pi.skills` in `package.json` (an explicit
`pi` manifest disables conventional directory discovery) and live in
`skills/<name>/SKILL.md` with Agent Skills spec frontmatter.

After editing `src/`, always `npm run build` and commit the regenerated
`dist/index.ts` — it is what Pi loads. See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the event-bus protocol, message
shape details, and design notes.

## License

MIT
