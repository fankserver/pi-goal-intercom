# Development notes

Protocol details, design decisions, and the release flow. User-facing usage
lives in the [root README](../README.md).

## Integration surface

All integration is over Pi's shared `pi.events` bus using **stable channel
strings only** — this package imports nothing from pi-goal or pi-intercom, so
it stays dependency-free and cannot break when those packages change internals:

| Channel | Direction | Payload |
| --- | --- | --- |
| `pi-goal:start` | emit | `{ runId, objective, tokenBudget? }` |
| `pi-goal:cancel` | emit | `{ runId, reason }` |
| `pi-goal:event:<runId>` | listen | `{ type: "state", runId, goalId, status, summary?, reason? }` or `{ type: "error", runId, operation, error: { code, message } }` |
| `intercom:outbox-request` | emit | `{ version: 1, requestId, extensionId, extensionName, to, message }` |
| `intercom:outbox-result` | listen | `{ requestId, status, code? }` — `sent`/`rejected`/`blocked`/`failed` are terminal |

Goal runIds are `pgi-<uuid>`, which satisfies pi-goal's
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.

## Budget: optional, discouraged, floored in code

`--tokens` is accepted and forwarded when supplied, because a sender naming a ceiling
is expressing a spend authorization and silently dropping it would spend more than
they agreed to. It is absent from every recommended form, and the discouragement is
**not** carried by documentation alone.

Evidence, not theory: an earlier revision of the bundled skill taught dispatchers to
size budgets; coordinators obliged with 40k and 60k against warmed 140k–235k contexts;
each one burned a single full request, produced no work, and left a `budget_limited`
goal holding the slot that nothing on the bus could free — four sessions at once. A
named, self-explanatory parameter out-competes prose telling agents to ignore it,
particularly toward a *motivated* error: senders want a cost cap.

Therefore `MIN_TOKEN_BUDGET = 150000` refuses anything lower with `BUDGET_TOO_LOW`,
explaining the cumulative-cost model, the jam, and the human-only recovery, and
recommending omission. The trailing-flag pattern deliberately matches `(\S+)` rather
than `(\d+)`: matching only a well-formed number let `--tokens abc` fall through as
objective prose and start an **unbounded** run — the exact opposite of what someone
typing a ceiling intended. Anything shaped like an attempted ceiling must be honoured
or refused loudly, never ignored.

Regression coverage is mutation-checked with the mutant required to compile and to be
present in `dist/` before a result is read: lowering the floor fails the sub-floor
checks, and narrowing the pattern back to digits fails the malformed-ceiling checks.
A blank compile or a stale bundle is treated as an invalid mutant, because a green
suite over an artifact that was never rebuilt measures nothing.

## Two pi-goal behaviours this package exists around

Both are upstream facts, verified in `src/run-protocol.ts`, and the extension is
built to report them honestly instead of papering over them:

1. **Cancel only pauses an `active` goal.** `cancelActiveRun` refuses any other
   status (`goal.status !== "active"` → `RUN_NOT_FOUND`) after closing the managed
   run, while `handleStart` rejects with `GOAL_ALREADY_EXISTS` as long as
   `runtime.activeGoal` exists. So a stopped goal occupies the slot and nothing on
   the bus can free it. `handleCancel` therefore always dispatches and reports
   pi-goal's real answer — it must not veto on our cached `lastStatus`, because a
   human may have resumed the goal — and `GOAL:STATUS` surfaces the stuck state.
2. **There is no budget-raise channel.** Only start and cancel exist, so raising an
   exhausted budget requires a human running `/goal edit --tokens`. Replies say so
   because the safe recovery for long work is raising the ceiling, not clearing.

## Why the command grammar is strict

The first version matched `text.includes("GOAL:START")` anywhere in the body. On
2026-10-09 a peer's bug report that *quoted* the marker inside backticks created a
live goal whose objective was that quoted paragraph — a description of the
interface invoked it and spent real money. `parseCommand` now requires the marker
as the first non-empty line of the body (after stripping the pi-intercom delivery
envelope), unwrapped in code delimiters and outside fenced blocks. `test/smoke.mjs`
replays the verbatim inbound traffic from `test/fixtures/` and asserts zero goals
start, with the coordinator's real commands from the same day as a positive
control so the fix cannot degrade into "never fire".

## Replay safety on resume and reload

A session resume or `/reload` re-presents the **entire stored message history** to
the `context` handler, so a command text from hours ago arrives looking exactly
like a fresh delivery. The first version deduped with an in-memory
`Set<timestamp:length:kind>`, which cannot survive that boundary: on 2026-10-09 a
session restarted at 16:24, re-saw a genuine `GOAL:START` from 14:02 in the
replayed history, created a fresh goal (`fb245fd2`), and spent 72 seconds of real
paid turns re-running an objective that had completed hours earlier.

Two independent guards, because either can fail open alone:

1. **Delivery-stamp age.** `envelopeMeta()` reads `injected` (falling back to
   `receiver received`, `broker delivered`, `sent`) from the pi-intercom envelope.
   A command delivered before this process started minus `REPLAY_GRACE_MS` is
   history — replayed history cannot be newer than the process reading it. A
   missing stamp fails **open**, so a live delivery with an unfamiliar envelope is
   never silently dropped.
2. **File-backed acted-on record.** `commandKey()` keys on the envelope `_id`
   (falling back to a SHA-256 digest) scoped by receiving session name, persisted
   to `~/.pi/agent/pi-goal-intercom-processed.json` (`PI_GOAL_INTERCOM_STATE_DIR`
   overrides; bounded to the last 400 keys). This is what catches a replay whose
   stamps were rewritten, and it survives reload where the memory set does not.

The record is shared by sibling sessions and written read-modify-write: a lost
concurrent write is benign because guard 1 still stands. Session scoping in the key
matters because a fan-out message keeps one delivery id for every target, and each
target must decide for itself.

`test/smoke.mjs` maps these directly: replaying a genuine command with an hours-old
stamp starts nothing, the same command with current stamps does start, and — the
case that isolates the durable guard — a fresh boot with an empty memory set, the
same delivery id already recorded, and stamps re-written to now still starts
nothing. Negative fixtures are re-stamped as live deliveries, so they are stopped by
the **parser** rather than passing for the wrong reason under the age gate.

## Why the `context` event is the trigger

Inbound intercom messages do **not** fire a dedicated "message received" event
and are **not** routed through Pi's slash-command parser: pi-intercom delivers
them with `pi.sendMessage({ customType: "intercom_message", … })` (a custom
message injected into the model's conversation) plus a
`pi.sendUserMessage("New intercom message above.")` wake. So `before_agent_start`
cannot see the body — its `prompt` is only the wake text.

The `context` event fires before each LLM call with the full `messages`
transcript, and the intercom body is present there as a `role: "custom"`,
`customType: "intercom_message"` message. That makes it the reliable hook.

Because a single run fires many `context` events, each detected message is
deduplicated by `${timestamp}:${length}`.

## Why the gate is evaluated lazily

`pi.getSessionName()` is an *action method*: calling it inside the extension
factory fails with

```text
Failed to load extension: Extension runtime not initialized.
Action methods cannot be called during extension loading.
```

Registering listeners in the factory is fine (pi-goal does the same), but the
session gate is therefore deferred to the first `context` event and cached.

## Status replies

Replies use pi-intercom's extension outbox rather than `intercom({action:
"send"})`, because an extension cannot invoke another extension's tool. Notes:

- The outbox is consent-aware: with `confirmSend: true` and no UI, requests fail
  closed with `confirmation_unavailable` (logged, non-fatal). The default is
  `confirmSend: false`, so headless sessions reply without prompting.
- The reply target is derived from the inbound message's `details.from` (session
  name, falling back to the session-id prefix). The outbox resolves the target
  through the session's own scoped intercom client, so this extension cannot
  choose the sender or resolved target id.
- `requestId` must be unique per session runtime; replies use
  `pgi-reply-<uuid>`.

## Terminal status mapping

Replies are sent for `active` plus these terminal states: `complete`,
`blocked`, `usage_limited`, `budget_limited`, `paused`, `cleared`, and for
`type: "error"` events (e.g. `RPC_DISABLED`, `GOAL_ALREADY_EXISTS`,
`RUN_ID_IN_USE`, `ACTIVATION_FAILED`). A guard ensures at most one terminal
reply per run.

## Cost model

The budget is cumulative for the whole run while each request re-sends the entire
conversation, and `usage.totalTokens` includes cached prompt input. Cost is
therefore `turns × contextTokens`, which makes context size — not turn count — the
dominant lever for long goals.

`automaticTurns: null` is the intended production setting: goals here may run for
weeks, and a finite cap would pause legitimate work into a stopped state that needs
a human to resume. Runaway loops are bounded instead by `continuationLimits.noProgressTurns`
plus a fingerprint of repeated tool-free assistant output. Do not recommend a turn
cap; recommend a budget sized to the horizon and lean sessions.

## Release flow

1. Edit `src/index.ts`.
2. `npm run check` — typecheck, build, smoke test.
3. **Commit the regenerated `dist/index.ts`** — it is the loadable runtime and is
   committed so git installs need no build step.
4. Tag: `git tag v0.1.0 && git push origin v0.1.0` so installs can be pinned with
   `pi install git:github.com/fankserver/pi-goal-intercom@v0.1.0`.
