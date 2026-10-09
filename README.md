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

Any intercom message body that reaches the target session:

```text
GOAL:START <objective> [--tokens <N>]
GOAL:CANCEL [reason]
```

From a sender session:

```typescript
intercom({
  action: "send",
  to: "worker",
  message: "GOAL:START finish README and commit it",
});
```

Examples:

```text
GOAL:START debug the flaky test in ./internal/policy until it is green --tokens 200000
GOAL:CANCEL owner changed direction
```

The sender gets status replies back over intercom:

```text
▶️ GOAL active: finish README and commit it
✅ GOAL complete: finish README and commit it — <completion summary>
⛔ GOAL blocked: … — <reason>          (also usage/budget/paused/cleared)
⚠️ GOAL:START rejected (RPC_DISABLED): Managed run RPC is disabled.
🛑 GOAL:CANCEL sent for run 12ab…
```

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

It documents both sides: sender-side `GOAL:START` / `GOAL:CANCEL` syntax and
budgets, the status replies to expect, a failure table (`RPC_DISABLED`,
`GOAL_ALREADY_EXISTS`, silent no-op), the session-name scope gate, and the
things that **cannot** work (no goal-start tool; `/goal` in a message body is
inert). Restart the session after installing so the skill is discovered.

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

A started goal runs **paid autonomous turns** (pi-goal keeps going after the
session goes idle, and `automaticTurns: null` means no response-count cap).
Treat `GOAL:START` as a real instruction and pass `--tokens` for open-ended
objectives. Status replies are feedback, not authorization.

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
