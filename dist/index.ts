/**
 * pi-goal-intercom
 *
 * Start and cancel pi-goal managed runs from an inbound intercom message.
 *
 * Protocol (any message body that a session receives via pi-intercom):
 *
 *   GOAL:START <objective> [--tokens <N>]   starts a real pi-goal managed run
 *   GOAL:CANCEL [reason]                     cancels the most recent run started
 *                                            by this extension in this session
 *
 * The extension listens on the `context` event for `intercom_message` custom
 * messages, extracts the marker + objective, and drives the pi-goal Managed Run
 * RPC over the shared `pi.events` bus:
 *
 *   - "pi-goal:start"   with { runId, objective, tokenBudget? }  (budget optional, floored)
 *   - "pi-goal:cancel"  with { runId, reason }
 *   - "pi-goal:event:<runId>" to observe state and terminal events
 *
 * It then replies to the SENDER over intercom (pi-intercom's extension outbox)
 * with the goal status: active, a terminal outcome, or a rejection/error.
 *
 * Requirements:
 *   - @narumitw/pi-goal (or another pi-goal implementation of the Managed Run
 *     RPC) installed, with `rpc.enabled: true` in pi-goal.json.
 *   - pi-intercom present, for the status reply (optional; goal start still
 *     works without it).
 *
 * Safety scoping: this extension is intentionally INERT in every session whose
 * name does not start with "test", unless PI_GOAL_INTERCOM_ALLOW=1 is set. It
 * never activates for unrelated project sessions, so installing it globally is
 * safe. See docs/README.md for the exact gate, objecting notes, and security.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Stable event-bus channel names, defined locally so this package stays
 * dependency-free. They are part of the public contracts:
 *   - pi-goal Managed Run RPC (the "pi-goal:start" / "pi-goal:cancel" /
 *     "pi-goal:event:<runId>" channels)
 *   - pi-intercom extension outbox (the "intercom:outbox-request" /
 *     "intercom:outbox-result" channels)
 */
const GOAL_START_CHANNEL = "pi-goal:start";
const GOAL_CANCEL_CHANNEL = "pi-goal:cancel";
const INTERCOM_OUTBOX_REQUEST = "intercom:outbox-request";
const INTERCOM_OUTBOX_RESULT = "intercom:outbox-result";

const MARKER_START = "GOAL:START";
const MARKER_CANCEL = "GOAL:CANCEL";
const MARKER_STATUS = "GOAL:STATUS";

/**
 * Strict command grammar.
 *
 * The original matcher was `text.includes("GOAL:START")`, which let a peer that
 * merely *described* the protocol start a real, paying, autonomous goal: a
 * peer report quoting `` `GOAL:START <objective> --tokens 40000` `` created a
 * live goal whose objective was that quoted paragraph. A description of the
 * interface must never be able to invoke it, so a command must be the first
 * non-empty line of the message body, unwrapped in code delimiters, outside any
 * fenced block. Quoted, bulleted, prefixed, or mid-sentence occurrences are
 * ignored.
 */
const COMMAND_RE = new RegExp(`^(${MARKER_START}|${MARKER_CANCEL}|${MARKER_STATUS})$`, "u");

const SELF_ID = "pi-goal-intercom";
const SELF_NAME = "pi-goal-intercom";

const MAX_OBJECTIVE_LENGTH = 4_000;
/** pi-goal's runId pattern: ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ */
const TERMINAL_GOAL_STATUSES = new Set([
	"complete",
	"blocked",
	"usage_limited",
	"budget_limited",
	"paused",
	"cleared",
]);
/**
 * Statuses pi-goal keeps in `activeGoal` after a run stops. pi-goal's managed
 * cancel only pauses an *active* goal (run-protocol.ts refuses any other
 * status), and a stopped goal still blocks `pi-goal:start`
 * (`GOAL_ALREADY_EXISTS`), so these need a human `/goal clear` upstream.
 */
const STOPPED_GOAL_STATUSES = new Set([
	"paused",
	"blocked",
	"usage_limited",
	"budget_limited",
]);
/** Statuses meaning the goal is finished and there is nothing to cancel. */
const FINISHED_GOAL_STATUSES = new Set(["complete", "cleared"]);

/**
 * How long to wait for pi-goal to confirm a cancel. It answers synchronously on
 * the reject path and from the state snapshot on the accept path, so this only
 * bounds the "pi-goal is absent" case.
 */
const CANCEL_CONFIRM_TIMEOUT_MS = 5_000;

const LOG_PATH = process.env.PI_GOAL_INTERCOM_LOG || "/tmp/pi-goal-intercom.log";

// Every session on this machine appends to the same file, so an untagged line is
// unattributable: during live validation the only way to tell which session logged
// what was to infer it from a neighbouring `gate` line. PI_SESSION_ID is per process,
// which also survives /reload re-running the factories.
const PROCESS_TAG = (process.env.PI_SESSION_ID ?? process.pid.toString(36)).slice(0, 8);

function log(msg: string): void {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} [${PROCESS_TAG}] ${msg}\n`);
	} catch {
		/* diagnostics must never break the session */
	}
}

/*
 * Replay protection. A session resume or `/reload` re-presents the ENTIRE stored
 * message history to the `context` handler, so an hours-old command text arrives
 * again looking exactly like a fresh delivery. On 2026-10-09 a restarted session
 * re-executed a `GOAL:START` from earlier that day and spent 72 seconds of real
 * paid turns re-running an objective that had finished hours before. An
 * in-memory dedupe set cannot survive that boundary, so there are two
 * independent guards, each able to catch what the other misses:
 *   1. the delivery stamp predates this process — replayed history cannot be
 *      newer than the process that is reading it;
 *   2. the delivery id is in a file-backed acted-on record that does survive it.
 */
const STATE_DIR = process.env.PI_GOAL_INTERCOM_STATE_DIR ?? join(homedir(), ".pi", "agent");
const PROCESSED_PATH = join(STATE_DIR, "pi-goal-intercom-processed.json");
const MAX_PROCESSED_KEYS = 400;

/**
 * Lowest budget this bridge will honour, in tokens. Sized from production jams at
 * 40k/60k against warmed 140k-235k contexts: below roughly one turn a budget is pure
 * loss, and the loss is a jammed slot rather than a clean stop. It is a floor, not a
 * default — the recommended setting is no budget at all.
 */
const MIN_TOKEN_BUDGET = 150000;

/** Clock-skew allowance for the replay gate. */
const REPLAY_GRACE_MS = 5000;

export interface EnvelopeMeta {
	id?: string;
	deliveredMs?: number;
}

/** Read the pi-intercom delivery envelope for idempotency and replay facts. */
export function envelopeMeta(text: string): EnvelopeMeta {
	const head = text.slice(0, 600);
	const out: EnvelopeMeta = {};
	const id = /_id\s+([0-9a-f][0-9a-f-]{7,39})/u.exec(head);
	if (id?.[1]) out.id = id[1];
	for (const field of ["injected", "receiver received", "broker delivered", "sent"]) {
		const m = new RegExp(`${field}\\s+(\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z)`, "u").exec(head);
		const ms = m?.[1] ? Date.parse(m[1]) : Number.NaN;
		if (!Number.isNaN(ms)) {
			out.deliveredMs = ms;
			break;
		}
	}
	return out;
}

/** Stable key for a command message: its delivery id, or a content digest. */
export function commandKey(id: string | undefined, text: string): string {
	return id ?? `h:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) =>
				block &&
				typeof block === "object" &&
				(block as { type?: string }).type === "text" &&
				typeof (block as { text?: string }).text === "string"
					? (block as { text: string }).text
					: " ",
			)
			.join("\n");
	}
	return "";
}

interface IntercomSender {
	name?: string;
	id?: string;
}

/** Pull the sender out of the intercom_message custom entry's details. */
function senderOf(details: unknown): IntercomSender | undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as {
		from?: { name?: unknown; id?: unknown };
	};
	if (!record.from || typeof record.from !== "object") return undefined;
	const name =
		typeof record.from.name === "string" && record.from.name.trim()
			? record.from.name.trim()
			: undefined;
	const id =
		typeof record.from.id === "string" && record.from.id.trim()
			? record.from.id.trim()
			: undefined;
	return name || id ? { name, id } : undefined;
}

function short(s: string, n = 64): string {
	const collapsed = s.replace(/\s+/g, " ").trim();
	return collapsed.length > n ? `${collapsed.slice(0, n)}…` : collapsed;
}

/**
 * Strip the pi-intercom envelope so "first line" means the sender's first line,
 * not the delivery header. Inbound bodies look like:
 *
 *   **From NAME** (cwd)
 *   _id … · seq … · sent … · injected …_
 *   <actual message>
 */
function commandBody(text: string): string {
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i].trim();
		if (line === "") {
			i++;
			continue;
		}
		if (line.startsWith("**From ")) {
			i++;
			continue;
		}
		if (/^_id\b.*_$/.test(line)) {
			i++;
			break;
		}
		break;
	}
	return lines.slice(i).join("\n");
}

interface ParsedCommand {
	kind: "START" | "CANCEL" | "STATUS";
	/** Remainder of the command line plus any following lines. */
	argument: string;
}

/**
 * Recognise a command only in command position. Returns undefined for anything
 * else, including a message that merely mentions a marker.
 */
export function parseCommand(text: string): ParsedCommand | undefined {
	const lines = commandBody(text).split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (/^(`{3,}|~{3,})/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		if (line === "") continue;

		// Only the first real line can carry a command. Anything quoted,
		// bulleted, or wrapped in code delimiters is prose, not a command.
		if (/^[`>"'\[\]*(#-]/.test(line)) return undefined;
		const head = line.split(/\s/, 1)[0];
		if (!COMMAND_RE.test(head)) return undefined;
		// Derive the verb from the matched marker; capture groups would shift if
		// MARKER_* strings ever change length or order.
		const kind = head.slice("GOAL:".length) as ParsedCommand["kind"];
		const restOfLine = line.slice(head.length).trim();
		const tail = lines.slice(i + 1).join("\n").trim();
		// STATUS takes no argument, so ANY trailing text on that line is evidence the
		// writer is reporting on the protocol rather than invoking it. Observed in live
		// traffic: a peer answering a status query opened its reply with
		// "GOAL:STATUS result — Active goal in this session: none." and that was executed
		// as a command. CANCEL is held to the same whole-body rule (its reason is
		// optional, so a following paragraph is equally a sign of prose). START keeps
		// multi-line objectives, which are genuinely part of the command.
		if (kind === "STATUS" && (restOfLine !== "" || tail !== "")) return undefined;
		if (kind === "CANCEL" && tail !== "") return undefined;
		return { kind, argument: [restOfLine, tail].filter(Boolean).join("\n").trim() };
	}
	return undefined;
}

export default function goalIntercom(pi: ExtensionAPI): void {
	// getSessionName() is an action method and MUST NOT be called in the factory
	// (the extension runtime is not initialized yet during loading). Evaluate the
	// session gate lazily on the first actionable event instead.
	let gateDecided = false;
	let allowed = false;
	// Kept for operator-facing hints: a stuck goal must be cleared *in that session*.
	let sessionLabel = "";
	const gate = (): boolean => {
		if (gateDecided) return allowed;
		gateDecided = true;
		let sessionName = "";
		try {
			sessionName =
				typeof pi.getSessionName === "function"
					? (pi.getSessionName() ?? "")
					: "";
		} catch {
			sessionName = "";
		}
		allowed =
			sessionName.startsWith("test") ||
			process.env.PI_GOAL_INTERCOM_ALLOW === "1";
		sessionLabel = sessionName || "this session";
		log(`gate session=${JSON.stringify(sessionName)} allowed=${allowed}`);
		return allowed;
	};

	// Baseline for the replay gate: anything delivered before this factory ran is
	// history, not a new command. `/reload` re-runs the factory, which correctly
	// re-baselines and therefore never re-fires commands from the current chat.
	const processStartedMs = Date.now();

	// Already-acted-on command keys: in-memory for the repeated `context` events a
	// single run causes, backed by a file so it survives resume and reload.
	const consumed = new Set<string>();
	let durableProcessed = new Set<string>();
	let durableLoaded = false;
	const ensureDurableLoaded = (): Set<string> => {
		if (durableLoaded) return durableProcessed;
		durableLoaded = true;
		try {
			const raw = JSON.parse(readFileSync(PROCESSED_PATH, "utf8")) as { keys?: unknown };
			if (Array.isArray(raw.keys)) durableProcessed = new Set(raw.keys.filter((k) => typeof k === "string"));
		} catch {
			/* first run, or unreadable — the replay gate still stands on its own */
		}
		return durableProcessed;
	};
	const rememberProcessed = (key: string): void => {
		ensureDurableLoaded().add(key);
		try {
			const keys = [...durableProcessed].slice(-MAX_PROCESSED_KEYS);
			writeFileSync(PROCESSED_PATH, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`);
		} catch {
			/* shared with sibling sessions; a lost write is covered by the replay gate */
		}
	};

	/**
	 * The most recent run this extension started, live or settled. `lastStatus`
	 * is what pi-goal actually reported, never what we hoped — replies and hints
	 * are built from it so a sender is never told an action succeeded that did
	 * not.
	 */
	interface ManagedRun {
		runId: string;
		objective: string;
		sender?: IntercomSender;
		/** Echoed in the ack so a senders sees what they opted into. */
		tokenBudget?: number;
		/** True between the `active` state event and a terminal event. */
		live: boolean;
		settled: boolean;
		/** Whether the per-run event listener is currently attached. */
		listening: boolean;
		lastStatus?: string;
		/** Last status of the run this one replaced (for GOAL_ALREADY_EXISTS hints). */
		previousStatus?: string;
		unsubscribe: () => void;
		cancelTimer?: ReturnType<typeof setTimeout>;
		cancelSender?: IntercomSender;
	}
	let currentRun: ManagedRun | undefined;

	function clearCancelTimer(run: ManagedRun): void {
		if (run.cancelTimer === undefined) return;
		clearTimeout(run.cancelTimer);
		run.cancelTimer = undefined;
	}

	function settleRun(run: ManagedRun): void {
		run.live = false;
		run.settled = true;
		clearCancelTimer(run);
		if (run.listening) {
			run.listening = false;
			try {
				run.unsubscribe();
			} catch {
				/* listener already released */
			}
		}
	}

	/**
	 * Attach (or re-attach) the per-run listener. A cancel may arrive after a
	 * terminal event released the listener, and we still need pi-goal's real
	 * answer to it — so this is idempotent and re-armable.
	 */
	function attachRunListener(run: ManagedRun): void {
		if (run.listening) return;
		run.unsubscribe = pi.events.on(`pi-goal:event:${run.runId}`, (data) => {
			handleRunEvent(run, data);
		});
		run.listening = true;
	}

	/** What a sender must do to get unstuck, based on the status we observed. */
	function recoveryHint(status: string | undefined): string {
		if (status && STOPPED_GOAL_STATUSES.has(status)) {
			return ` The goal is ${status}, and pi-goal's managed cancel only pauses an ACTIVE goal — it leaves a stopped goal in place, where it keeps rejecting new starts. A human must run \`/goal clear\` in "${sessionLabel}", or \`/goal resume\` after raising the budget, before GOAL:START can succeed again.`;
		}
		if (status && FINISHED_GOAL_STATUSES.has(status)) {
			return ` The goal already finished (${status}); there is nothing to cancel.`;
		}
		return ` No live managed run matched that cancel — the goal may already be cleared, or was started by hand with /goal.`;
	}

	function alreadyExistsHint(previousStatus: string | undefined): string {
		if (previousStatus && STOPPED_GOAL_STATUSES.has(previousStatus)) {
			return ` The previous goal ended as ${previousStatus} and pi-goal retains stopped goals, so it is not really "already running" — it is stuck. Send GOAL:CANCEL (it will be refused) or ask an operator to run \`/goal clear\` in "${sessionLabel}" first, then re-send with a budget that covers several full turns.`;
		}
		if (previousStatus && FINISHED_GOAL_STATUSES.has(previousStatus)) {
			return ` The previous goal ended as ${previousStatus}; a manually started /goal may still be holding the slot.`;
		}
		return ` Another goal is genuinely active in "${sessionLabel}" — send GOAL:CANCEL first, or wait for its terminal reply.`;
	}

	function replyTo(sender: IntercomSender | undefined, message: string): void {
		if (!sender) {
			log(`no sender to reply to; message=${short(message, 120)}`);
			return;
		}
		const target = sender.name ?? sender.id?.slice(0, 8);
		if (!target) {
			log(`no resolvable sender target; message=${short(message, 120)}`);
			return;
		}
		const requestId = `pgi-reply-${randomUUID()}`;
		const unsubscribe = pi.events.on(INTERCOM_OUTBOX_RESULT, (data) => {
			const result = (data ?? {}) as {
				requestId?: string;
				status?: string;
				code?: string;
			};
			if (result.requestId !== requestId) return;
			log(
				`outbox to=${target} status=${result.status}${result.code ? ` code=${result.code}` : ""}`,
			);
			unsubscribe();
		});
		try {
			pi.events.emit(INTERCOM_OUTBOX_REQUEST, {
				version: 1,
				requestId,
				extensionId: SELF_ID,
				extensionName: SELF_NAME,
				to: target,
				message,
			});
		} catch (error) {
			log(
				`reply emit failed to=${target}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	function handleStart(objective: string, sender?: IntercomSender): void {
		const trimmed = objective.trim();
		if (!trimmed || trimmed.length > MAX_OBJECTIVE_LENGTH) {
			log(`skip: invalid objective length=${trimmed.length}`);
			replyTo(sender, "⚠️ GOAL:START ignored: objective missing or >4000 chars.");
			return;
		}
		// An explicit budget is honoured when given — a sender asking for a ceiling is
		// expressing a spend authorization, and silently dropping it would run past what
		// they agreed to. It is not advertised, because the flag is a footgun whose
		// failure mode is state damage rather than a clean stop: budgets are cumulative
		// COST (about turns x contextTokens with cached prompt input billed), which a
		// dispatcher cannot estimate from the objective, and exhausting one leaves a
		// stopped goal holding the slot that managed cancel cannot free, so a human has
		// to raise it inside that session. Observed at 40k and 60k against warmed
		// 140k-235k sessions: one full request burned, no work produced, four slots
		// jammed. Prose alone did not prevent that — the skill once recommended sizing
		// budgets and the coordinators obliged — so the protection is this floor.
		// Deliberately permissive: matching only a well-formed number would let
		// `--tokens 40k` or `--tokens abc` fall through as prose and start an UNBOUNDED
		// run, which is the opposite of what a sender typing a ceiling asked for. Anything
		// shaped like an attempted ceiling must be handled here or refused.
		const tokensMatch = /(?:^|\s)--tokens\s+(\S+)\s*$/u.exec(trimmed);
		const objectiveText = tokensMatch ? trimmed.slice(0, tokensMatch.index).trim() : trimmed;
		let tokenBudget: number | undefined;
		if (tokensMatch?.[1]) {
			const requested = Number(tokensMatch[1]);
			if (!Number.isSafeInteger(requested) || requested <= 0) {
				log(`skip: invalid tokenBudget=${JSON.stringify(tokensMatch[1])}`);
				replyTo(sender, "⚠️ GOAL:START ignored: --tokens must be a positive whole number, or omit it entirely.");
				return;
			}
			if (requested < MIN_TOKEN_BUDGET) {
				log(`reject reason=budget_too_low requested=${requested} floor=${MIN_TOKEN_BUDGET}`);
				replyTo(
					sender,
					`⚠️ GOAL:START rejected (BUDGET_TOO_LOW): ${requested} is below the ${MIN_TOKEN_BUDGET} floor and would likely be less than a single turn. Each request re-sends the whole conversation with cached prompt input billed, so a small budget burns one request, produces no work, and then leaves a stopped goal in this slot that managed cancel cannot free — a human must raise it in "${sessionLabel}". Prefer omitting --tokens (loop protection is pi-goal's no-progress detection, not a spend ceiling). If you genuinely need a cap, re-send with at least ${MIN_TOKEN_BUDGET}, sized as turns x contextTokens x 1.3.`,
				);
				return;
			}
			tokenBudget = requested;
			log(`budget accepted requested=${requested} floor=${MIN_TOKEN_BUDGET}`);
		}
		const runId = `pgi-${randomUUID()}`;
		// Capture the replaced run before overwriting it, so a GOAL_ALREADY_EXISTS
		// rejection can name the status the previous goal actually died in.
		const previousStatus = currentRun?.lastStatus ?? currentRun?.previousStatus;
		const run: ManagedRun = {
			runId,
			objective: objectiveText,
			tokenBudget,
			sender,
			live: false,
			settled: false,
			listening: false,
			previousStatus,
			unsubscribe: () => {},
		};

		attachRunListener(run);
		currentRun = run;

		log(
			`start runId=${runId} objective=${JSON.stringify(objectiveText)} sender=${sender?.name ?? sender?.id?.slice(0, 8) ?? "unknown"}`,
		);
		// An absent budget means "let pi-goal apply its own configured behaviour",
		// which is what a multi-week goal needs and the recommended path.
		pi.events.emit(GOAL_START_CHANNEL, {
			runId,
			objective: objectiveText,
			...(tokenBudget !== undefined ? { tokenBudget } : {}),
		});
	}

	/**
	 * One listener per run handles start outcomes, terminal states, and cancel
	 * confirmation, so every reply reports what pi-goal really did.
	 */
	function handleRunEvent(run: ManagedRun, data: unknown): void {
		const event = (data ?? {}) as {
			type?: string;
			status?: string;
			summary?: string;
			reason?: string;
			operation?: string;
			error?: { code?: string; message?: string };
		};
		log(
			`event runId=${run.runId} type=${event.type ?? "?"} status=${event.status ?? "-"} operation=${event.operation ?? "-"}`,
		);

		if (event.type === "error") {
			const code = event.error?.code ?? "error";
			const message = event.error?.message ?? event.reason ?? "no detail";
			// A cancel is only "in flight" while its confirmation timer is armed;
			// an error operation without one is pi-goal refusing a cancel we never sent.
			const confirmingCancel = run.cancelTimer !== undefined;
			clearCancelTimer(run);
			if (confirmingCancel || event.operation === "cancel") {
				replyTo(
					run.cancelSender ?? run.sender,
					`⚠️ GOAL:CANCEL refused (${code}): ${message}${recoveryHint(run.lastStatus)}`,
				);
			} else {
				replyTo(
					run.sender,
					`⚠️ GOAL:START rejected (${code}): ${message}${code === "GOAL_ALREADY_EXISTS" ? alreadyExistsHint(run.previousStatus) : ""}`,
				);
			}
			settleRun(run);
			return;
		}

		if (event.type !== "state") return;
		run.lastStatus = event.status;

		if (event.status === "active") {
			run.live = true;
			replyTo(
				run.sender,
				`▶️ GOAL active: ${short(run.objective)}${
					run.tokenBudget !== undefined
						? ` (budget ${run.tokenBudget.toLocaleString("en-US")} tokens — cumulative across the run; if it is reached, only a human can raise it in "${sessionLabel}")`
						: ""
				}`,
			);
			return;
		}

		if (event.status && TERMINAL_GOAL_STATUSES.has(event.status)) {
			run.live = false;
			if (run.cancelTimer !== undefined) {
				// This terminal state is the cancel we asked for: report the real status.
				const target = run.cancelSender ?? run.sender;
				clearCancelTimer(run);
				replyTo(
					target,
					`🛑 GOAL cancelled: ${iconFor(event.status)} ${event.status}${
						event.reason ? ` — ${short(event.reason, 160)}` : ""
					}`,
				);
			} else {
				const detail =
					event.status === "complete"
						? (event.summary ?? "completed")
						: (event.reason ?? "no detail");
				replyTo(
					run.sender,
					`${iconFor(event.status)} GOAL ${event.status}: ${short(run.objective)} — ${short(detail, 160)}${budgetRecoveryHint(event.status)}`,
				);
			}
			settleRun(run);
		}
	}

	/**
	 * A long-horizon goal reaching its budget is expected and recoverable, and the
	 * recovery must preserve work. pi-goal's `/goal edit --tokens` raises the
	 * ceiling on the SAME goal (commands.ts: `effectiveTokenBudget = tokenBudget ??
	 * currentGoal.tokenBudget`), keeping objective, cumulative usage, and elapsed
	 * time; `/goal clear` discards all of it. Say so, because clearing a goal that
	 * ran for days is data loss dressed up as recovery.
	 */
	function budgetRecoveryHint(status: string | undefined): string {
		if (status !== "budget_limited") return "";
		return ` Recovery: ask a human to run \`/goal edit --tokens <higher>\` in "${sessionLabel}" — it raises the ceiling and resumes THIS goal with its objective, progress, and cumulative usage intact. Do NOT run \`/goal clear\`: that discards the objective and every accumulated turn. Budgets are cumulative across the whole run while each turn re-sends the full context, so a large goal legitimately needs a large one — but only a human sets it here now, because this bridge never does.`;
	}

	function handleCancel(reason: string | undefined, sender?: IntercomSender): void {
		const run = currentRun;
		if (!run) {
			replyTo(
				sender,
				"⚠️ GOAL:CANCEL ignored: this extension never started a goal in this session.",
			);
			return;
		}
		// Never veto a cancel on our own cached observation. `lastStatus` is what we
		// last saw, not what is true now — a human may have run `/goal resume`, in
		// which case a cancel for a goal we believe stopped will legitimately
		// succeed. pi-goal owns the state, so always ask it and report the answer.
		attachRunListener(run);
		run.settled = false;
		const cleanReason = reason?.trim() || "goal cancelled via intercom";
		run.cancelSender = sender ?? run.sender;
		run.cancelTimer = setTimeout(() => {
			run.cancelTimer = undefined;
			replyTo(
				run.cancelSender ?? run.sender,
				`⚠️ GOAL:CANCEL got no confirmation from pi-goal within ${CANCEL_CONFIRM_TIMEOUT_MS / 1000}s; the goal may still be running. Check /goal status in "${sessionLabel}".`,
			);
			settleRun(run);
		}, CANCEL_CONFIRM_TIMEOUT_MS);
		log(`cancel runId=${run.runId} reason=${JSON.stringify(cleanReason)}`);
		pi.events.emit(GOAL_CANCEL_CHANNEL, {
			runId: run.runId,
			reason: cleanReason,
		});
	}

	function handleStatus(sender?: IntercomSender): void {
		const run = currentRun;
		if (!run) {
			replyTo(
				sender,
				`ℹ️ GOAL:STATUS — no managed run has been observed in this session runtime. State is not recoverable across a session restart, so an empty answer here does NOT prove the slot is free; ask for \`/goal status\` in "${sessionLabel}".`,
			);
			return;
		}
		const state = run.live ? "live" : run.settled ? "settled" : "starting";
		const lines = [
			`ℹ️ GOAL:STATUS — run ${short(run.runId, 20)}`,
			`state: ${state}`,
			`last status reported by pi-goal: ${run.lastStatus ?? "(none yet)"}`,
			`objective: ${short(run.objective, 120)}`,
		];
		if (run.previousStatus) lines.push(`replaced goal ended as: ${run.previousStatus}`);
		if (!run.live && run.lastStatus && STOPPED_GOAL_STATUSES.has(run.lastStatus)) {
			lines.push(
				`STUCK: a stopped goal still occupies the slot and managed cancel cannot clear it; a human must run \`/goal clear\` (or \`/goal edit --tokens\` to keep its progress) in "${sessionLabel}".`,
			);
		}
		replyTo(sender, lines.join("\n"));
	}

	function handleCommand(command: ParsedCommand, sender?: IntercomSender): void {
		switch (command.kind) {
			case "START":
				handleStart(command.argument, sender);
				return;
			case "CANCEL":
				handleCancel(command.argument || undefined, sender);
				return;
			case "STATUS":
				handleStatus(sender);
				return;
		}
	}

	pi.on("context", (event) => {
		if (!gate()) return;
		const messages = (event as { messages?: unknown[] }).messages ?? [];
		const actionable: Array<{ command: ParsedCommand; sender?: IntercomSender; key: string }> = [];
		for (const raw of messages) {
			const m = raw as {
				role?: string;
				customType?: string;
				content?: unknown;
				timestamp?: number;
				details?: unknown;
			} | null;
			if (!m || m.role !== "custom" || m.customType !== "intercom_message") continue;
			const text = messageText(m.content);
			const command = parseCommand(text);
			if (!command) continue;
			const meta = envelopeMeta(text);
			// Scoped to the receiving session: a fan-out message keeps one delivery id
			// for every target, and each target must decide for itself.
			const key = `${sessionLabel}|${commandKey(meta.id, text)}`;
			if (
				meta.deliveredMs !== undefined &&
				meta.deliveredMs < processStartedMs - REPLAY_GRACE_MS
			) {
				log(
					`ignored replayed command kind=${command.kind} delivered=${new Date(meta.deliveredMs).toISOString()} (process started ${new Date(processStartedMs).toISOString()})`,
				);
				continue;
			}
			if (consumed.has(key) || ensureDurableLoaded().has(key)) {
				log(`ignored duplicate command kind=${command.kind} key=${key.slice(0, 48)}`);
				continue;
			}
			actionable.push({ command, sender: senderOf(m.details), key });
		}
		// Oldest first, and never stop at the first hit. Walking newest-first and
		// breaking meant that when two commands arrived between two prompt builds,
		// only the newer one was ever handled: the next scan met the newer one in the
		// dedupe set, stopped there, and the queued older command could never run.
		for (const item of actionable) {
			consumed.add(item.key);
			rememberProcessed(item.key);
			log(`command kind=${item.command.kind} from=${item.sender?.name ?? item.sender?.id?.slice(0, 8) ?? "?"}`);
			handleCommand(item.command, item.sender);
		}
	});

	// Release the pending cancel timer and the run's event listener on teardown.
	pi.on("session_shutdown", () => {
		if (!currentRun) return;
		settleRun(currentRun);
		currentRun = undefined;
	});
}

function iconFor(status: string): string {
	switch (status) {
		case "complete":
			return "✅";
		case "blocked":
			return "⛔";
		case "usage_limited":
		case "budget_limited":
			return "💰";
		case "paused":
			return "⏸️";
		case "cleared":
			return "🧹";
		default:
			return "🔁";
	}
}
