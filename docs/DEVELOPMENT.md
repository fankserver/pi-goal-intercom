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
| `pi-goal:event:<runId>` | listen | `{ type: "state", runId, goalId, status, summary?, reason? }` or `{ type: "error", … }` |
| `intercom:outbox-request` | emit | `{ version: 1, requestId, extensionId, extensionName, to, message }` |
| `intercom:outbox-result` | listen | `{ requestId, status, code? }` — `sent`/`rejected`/`blocked`/`failed` are terminal |

Goal runIds are `pgi-<uuid>`, which satisfies pi-goal's
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.

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

## Cost caveat

pi-goal continues a goal automatically after the session goes idle. With
pi-goal's `automaticTurns: null` there is no response-count cap, so an
open-ended objective can run unbounded paid turns. Encourage `--tokens`, or
configure a finite `automaticTurns` in `pi-goal.json`.

## Release flow

1. Edit `src/index.ts`.
2. `npm run check` — typecheck, build, smoke test.
3. **Commit the regenerated `dist/index.ts`** — it is the loadable runtime and is
   committed so git installs need no build step.
4. Tag: `git tag v0.1.0 && git push origin v0.1.0` so installs can be pinned with
   `pi install git:github.com/fankserver/pi-goal-intercom@v0.1.0`.
