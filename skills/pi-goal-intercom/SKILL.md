---
name: pi-goal-intercom
description: Start, cancel, and monitor an autonomous pi-goal run in another Pi session through intercom. Use when delegating multi-step work that should keep running after the target session goes idle, when asked to "set a goal" or "give that session an objective" for a peer session, when a task needs an intercom-triggered goal rather than a one-shot intercom request, or when reporting the outcome of such a delegated goal. Provides the GOAL:START and GOAL:CANCEL message protocol.
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

## Why this is the only way to do it

Do **not** try these — they do not work, so don't waste a turn on them:

- You cannot run `/goal` yourself, and you have no goal-start tool. Your only
  goal tools (`goal_complete`, `goal_blocked`, `goal_wait`) require an already
  active goal, created by a human typing `/goal` in that session.
- Intercom messages are delivered to the target's **model**, not to its host
  command parser, so a message containing `/goal ...` is inert text.
- The goal tools reject calls without a matching active `goal_id`.

This extension is the sanctioned bridge: it listens on the target's message
transcript and starts the goal programmatically there.

## Commands

Send to the target session with the `intercom` tool. The marker must appear in
the message body.

**Start a goal:**

```typescript
intercom({
  action: "send",
  to: "<target-session>",
  message: "GOAL:START <objective>",
});
```

```text
GOAL:START <objective> [--tokens <N>]
```

- `<objective>` is the full contract the remote agent must satisfy, ≤4000 chars.
- `--tokens <N>` sets a token budget. **Use it for open-ended work** — the
  remote pi-goal may have unlimited automatic turns and will keep spending.
- Prefer a self-terminating objective (explicit artifact + how to prove it done)
  so the remote run reaches `goal_complete` promptly.

**Cancel the most recent goal this extension started in that session:**

```text
GOAL:CANCEL [reason]
```

**Check what exists:** `intercom({ action: "list" })` shows sessions and state.

## Status replies you should expect

The target replies to you over intercom:

| Reply | Meaning | Next step |
| --- | --- | --- |
| `▶️ GOAL active: …` | goal accepted and running | wait; do not re-send the same objective |
| `✅ GOAL complete: … — <summary>` | done, evidence-based | verify the artifact yourself |
| `⛔ GOAL blocked: …` | needs a human/external action | resolve the stated condition, or re-goal |
| `💰 GOAL budget_limited / usage_limited` | budget/provider cap | raise budget or resume in that session |
| `⏸️ GOAL paused` / `🧹 cleared` | paused or discarded | decide whether to restart |
| `⚠️ GOAL:START rejected (<code>)` | never started | see failure table |
| `🛑 GOAL:CANCEL sent` | cancel delivered | confirm the goal stopped |

Treat `complete` as a **claim**, not proof: the extension cannot verify external
work. Inspect the actual file, test run, PR, or rendered output before reporting
success.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `rejected (RPC_DISABLED)` | `rpc.enabled` is false in `pi-goal.json` | set it to true and restart that session |
| `rejected (GOAL_ALREADY_EXISTS)` | a goal is already active there | `GOAL:CANCEL` first, or wait |
| `rejected (RUN_ID_IN_USE)` | duplicate run id | send a fresh objective |
| No reply at all | that session is not in the allowed scope, or no goal ran | see scope below |
| Silent, no goal | pi-goal absent, or the session name is outside the gate | check requirements |

## Scope gate (why a goal may silently not start)

The extension is inert unless the **target** session's name starts with `test`,
or that session was launched with `PI_GOAL_INTERCOM_ALLOW=1`. So:

- Do not assume a goal started just because the send succeeded. If no `▶️ GOAL
  active` arrives, the target is probably out of scope — say so rather than
  reporting success.
- Check the target's name first with `intercom({ action: "list" })`.
- Starting a goal in a normal project session needs an operator to set
  `PI_GOAL_INTERCOM_ALLOW=1` there; that is an operator decision, not yours.

## Etiquette

- One objective per message; do not stack several goals on one session.
- Don't re-send an objective that already went active — wait for the terminal
  reply.
- Use a budgeted, self-terminating objective for anything vague.
- Report the terminal status to the user with the evidence you actually checked.
