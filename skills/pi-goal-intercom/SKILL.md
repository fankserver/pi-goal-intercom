---
name: pi-goal-intercom
description: Start, cancel, monitor, and budget-query an autonomous pi-goal run in another Pi session through intercom. Use when delegating multi-step work that should keep running after the target session goes idle, when asked to "set a goal" or "give that session an objective" for a peer session, when a task needs an intercom-triggered goal rather than a one-shot intercom request, when reporting the outcome of a delegated goal, or when a goal dispatch returns GOAL_ALREADY_EXISTS and you need to know whether the slot is genuinely busy or stuck. Provides the GOAL:START, GOAL:CANCEL, and GOAL:STATUS message protocol.
license: MIT
compatibility: Requires the pi-goal-intercom extension, @narumitw/pi-goal with rpc.enabled, and pi-intercom. Only acts in sessions whose name starts with "test" or that set PI_GOAL_INTERCOM_ALLOW=1.
metadata:
  package: pi-goal-intercom
  repository: https://github.com/fankserver/pi-goal-intercom
---

# pi-goal-intercom: delegate goals over intercom

Use this when work should run **autonomously inside another session** — not as a
single request/response. The extension turns an inbound intercom message into a
real `pi-goal` managed run and reports status back to you over intercom.

## Command position is strict — read this first

A command must be the **first non-empty line of the message body**, unwrapped in
code delimiters, outside any fenced block:

```text
GOAL:START <objective> [--tokens <N>]
GOAL:CANCEL [reason]
GOAL:STATUS
```

Anything else is prose and is ignored: a marker mid-sentence, inside backticks,
in a blockquote, on a bullet, or in a code fence. This is deliberate. A previous
version matched the marker anywhere in the message, and a peer that merely
*described* the protocol in a bug report started a real, paying, autonomous goal
whose objective was that quoted paragraph. **Never rely on a quoted marker doing
nothing in a tool you do not control — and never paste a marker into prose when
writing a report; write `GOAL-START` without the colon.**

## Why this is the only way to do it

Do **not** try these — they do not work, so do not waste a turn on them:

- You cannot run `/goal` yourself, and you have no goal-start tool. Your only
  goal tools (`goal_complete`, `goal_blocked`, `goal_wait`) require an already
  active goal, created by a human typing `/goal` in that session.
- Intercom messages reach the target's **model**, never its slash-command parser,
  so a message containing `/goal ...` is inert text.
- The goal tools reject calls without a matching active `goal_id`.

## Commands

```typescript
intercom({ action: "send", to: "<target-session>", message: "GOAL:START <objective> --tokens 800000" });
```

- `<objective>` ≤4000 chars. Prefer a self-terminating contract: the artifact plus
  how to prove it done, so the run reaches `goal_complete` promptly.
- `GOAL:STATUS` returns the run this extension last observed, its real status, and
  whether the slot is stuck. Send it before retrying anything.
- `GOAL:CANCEL [reason]` is dispatched to pi-goal and **confirmed from its answer**.
- Check the target's name and context first: `intercom({ action: "list" })`.

## Sizing `--tokens` (the mistake that jams sessions)

The budget is **cumulative for the whole goal run**, and every model request
re-sends the entire conversation, with cached prompt input billed. From a real
turn: `input 39,837 + cacheRead 20,096 + output 93 = totalTokens 60,026` — 60k
billed for 93 tokens of work.

```
cost ≈ turns × contextTokens        →   --tokens ≥ planned_turns × contextTokens × 1.3
```

Read `contextTokens` from `intercom list`. So:

- **A budget below one turn is worse than no budget at all.** It burns a full
  request, produces nothing, and leaves the goal in `budget_limited`, which then
  rejects every new start. A 40k budget against a 175k-context session is less
  than a single request.
- Size for the **whole horizon**, including long runs. Some goals legitimately run
  for weeks; that is intended, and `automaticTurns` is unlimited by design here.
  Do not suggest a finite turn cap: it would pause productive work. Runaway loops
  are caught instead by `noProgressTurns` plus a fingerprint of repeated tool-free
  output.
- The real spend lever for long goals is **context size**, not turn count: keep
  sessions lean, compact in time, and objectives narrow.
- A budget being reached is a **wrap-up signal**, not a cliff — pi-goal injects a
  wrap-up prompt before the hard stop, and the final call may exceed it.

## Status replies

| Reply | Meaning | Next step |
| --- | --- | --- |
| `▶️ GOAL active` | accepted and running | wait; never re-send the same objective |
| `✅ GOAL complete — <summary>` | done, evidence-based | verify the artifact yourself |
| `⛔ GOAL blocked` | needs external action | resolve it or re-goal |
| `💰 GOAL budget_limited` | cumulative budget reached | **raise it, never clear** (below) |
| `🛑 GOAL cancelled: <status>` | cancel confirmed by pi-goal | done |
| `⚠️ GOAL:CANCEL refused (<code>)` | pi-goal would not cancel it | follow the stated recovery |
| `⚠️ GOAL:START rejected (<code>)` | never started | see failure table |
| `ℹ️ GOAL:STATUS … STUCK` | stopped goal still holding the slot | human action required |

Treat `complete` as a **claim, not proof**: inspect the actual file, test run, PR,
or rendered output before reporting success.

## When a slot is stuck — and how to get it back

pi-goal's managed cancel only pauses a goal that is exactly `active`. A goal in
`budget_limited`, `paused`, `blocked`, or `usage_limited` **persists** and keeps
rejecting new starts, and clearing it is not reachable from the extension bus
(only `pi-goal:start` and `pi-goal:cancel` exist). These need a human in that
session:

- **A long-running goal that used up its budget: run `/goal edit --tokens <higher>`.**
  This raises the ceiling and resumes the *same* goal with its objective,
  cumulative usage, and elapsed time preserved. **Do not run `/goal clear`** —
  that discards the objective and every accumulated turn, which for a goal that
  ran for days is data loss dressed up as recovery.
- **A goal that is genuinely wrong** (a typo, a stray dispatch): `/goal clear` is
  correct, and it is cheaper than restarting the session — restarting throws away
  the session's context too.
- Only a human can do either; an agent has no goal-clear tool.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `rejected (RPC_DISABLED)` | `rpc.enabled` false in `pi-goal.json` | set true, restart that session |
| `rejected (GOAL_ALREADY_EXISTS)` + `STUCK` from `GOAL:STATUS` | stopped goal still held | human `/goal edit --tokens` or `/goal clear` |
| `rejected (GOAL_ALREADY_EXISTS)` without `STUCK` | a goal really is running | wait for its terminal reply, or `GOAL:CANCEL` |
| `rejected (RUN_ID_IN_USE)` | duplicate run id | send a fresh objective |
| `GOAL:CANCEL refused (RUN_NOT_FOUND)` | goal is not active | human action above |
| No reply at all | target outside the name gate, or no goal ran | check scope with `intercom list` |

## Scope gate

Inert unless the **target** session's name starts with `test`, or it was launched
with `PI_GOAL_INTERCOM_ALLOW=1`. So a missing reply usually means the target is
out of scope — say so rather than reporting success. Starting a goal in a normal
project session requires an operator to set that variable; that is their decision.

## Etiquette

- One objective per message; never stack goals on one session.
- Never re-send an objective that already went active — wait for the terminal reply.
- Before any retry, send `GOAL:STATUS`; do not guess from `GOAL_ALREADY_EXISTS`.
- Report terminal status with the evidence you actually checked.
- Restarting or reloading a target does **not** re-run its last goal — commands are
  exactly-once per delivery id. To deliberately re-run something, send a **new**
  message; re-pasting the old text will not re-fire it.
