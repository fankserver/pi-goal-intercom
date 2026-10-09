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
 *   - "pi-goal:start"   with { runId, objective, tokenBudget? }
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
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

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

const LOG_PATH = process.env.PI_GOAL_INTERCOM_LOG || "/tmp/pi-goal-intercom.log";

function log(msg: string): void {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		/* diagnostics must never break the session */
	}
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

export default function goalIntercom(pi: ExtensionAPI): void {
	// getSessionName() is an action method and MUST NOT be called in the factory
	// (the extension runtime is not initialized yet during loading). Evaluate the
	// session gate lazily on the first actionable event instead.
	let gateDecided = false;
	let allowed = false;
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
		log(`gate session=${JSON.stringify(sessionName)} allowed=${allowed}`);
		return allowed;
	};

	// Message timestamps already handled this session (dedupe across the many
	// `context` events a single run may fire).
	const consumed = new Set<string>();
	// runId of the most recent managed run started by this extension.
	let lastRunId: string | undefined;

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
		// Optional trailing token budget: "GOAL:START ... --tokens 50000".
		const tokensMatch = /--tokens\s+(\d+)\s*$/.exec(trimmed);
		const budgetText = tokensMatch ? tokensMatch[1] : undefined;
		const objectiveText = tokensMatch
			? trimmed.slice(0, tokensMatch.index).trim()
			: trimmed;
		if (!objectiveText) {
			log("skip: empty objective after budget parsing");
			return;
		}
		const tokenBudget =
			budgetText !== undefined ? Number(budgetText) : undefined;
		if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
			log(`skip: invalid tokenBudget=${budgetText}`);
			replyTo(sender, "⚠️ GOAL:START ignored: invalid --tokens value.");
			return;
		}

		const runId = `pgi-${randomUUID()}`;
		lastRunId = runId;
		let terminalReplied = false;

		const unsubscribe = pi.events.on(`pi-goal:event:${runId}`, (data) => {
			const event = (data ?? {}) as {
				type?: string;
				status?: string;
				summary?: string;
				reason?: string;
				error?: { code?: string; message?: string };
			};
			log(
				`event runId=${runId} type=${event.type ?? "?"} status=${event.status ?? "-"}`,
			);
			if (terminalReplied) {
				// Extremely unlikely but guard against double replies.
				return;
			}
			if (event.type === "error") {
				terminalReplied = true;
				replyTo(
					sender,
					`⚠️ GOAL:START rejected (${event.error?.code ?? "error"}): ${event.error?.message ?? event.reason ?? "no detail"}`,
				);
				unsubscribe();
				return;
			}
			if (event.type !== "state") return;
			if (event.status === "active") {
				replyTo(sender, `▶️ GOAL active: ${short(objectiveText)}`);
				return;
			}
			if (event.status && TERMINAL_GOAL_STATUSES.has(event.status)) {
				terminalReplied = true;
				const detail =
					event.status === "complete"
						? (event.summary ?? "completed")
						: (event.reason ?? "no detail");
				replyTo(
					sender,
					`${iconFor(event.status)} GOAL ${event.status}: ${short(objectiveText)} — ${short(detail, 160)}`,
				);
				unsubscribe();
			}
		});

		log(
			`start runId=${runId} objective=${JSON.stringify(objectiveText)} tokenBudget=${tokenBudget ?? "none"} sender=${sender?.name ?? sender?.id?.slice(0, 8) ?? "unknown"}`,
		);
		pi.events.emit(GOAL_START_CHANNEL, {
			runId,
			objective: objectiveText,
			...(tokenBudget !== undefined ? { tokenBudget } : {}),
		});
	}

	function handleCancel(reason: string | undefined, sender?: IntercomSender): void {
		if (!lastRunId) {
			replyTo(
				sender,
				"⚠️ GOAL:CANCEL ignored: no run was started by this extension in this session.",
			);
			return;
		}
		const cleanReason = reason?.trim() || "goal cancelled via intercom";
		log(`cancel runId=${lastRunId} reason=${JSON.stringify(cleanReason)}`);
		pi.events.emit(GOAL_CANCEL_CHANNEL, {
			runId: lastRunId,
			reason: cleanReason,
		});
		replyTo(sender, `🛑 GOAL:CANCEL sent for run ${lastRunId.slice(0, 12)}…`);
	}

	function handleMessage(text: string, sender?: IntercomSender): void {
		if (text.includes(MARKER_START)) {
			const idx = text.indexOf(MARKER_START);
			handleStart(text.slice(idx + MARKER_START.length).replace(/^:\s*/, ""), sender);
			return;
		}
		if (text.includes(MARKER_CANCEL)) {
			const idx = text.indexOf(MARKER_CANCEL);
			handleCancel(
				text.slice(idx + MARKER_CANCEL.length).replace(/^:\s*/, "") || undefined,
				sender,
			);
		}
	}

	pi.on("context", (event) => {
		if (!gate()) return;
		const messages = (event as { messages?: unknown[] }).messages ?? [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as {
				role?: string;
				customType?: string;
				content?: unknown;
				timestamp?: number;
				details?: unknown;
			} | null;
			if (!m || m.role !== "custom" || m.customType !== "intercom_message") continue;
			const text = messageText(m.content);
			if (!text.includes(MARKER_START) && !text.includes(MARKER_CANCEL)) continue;
			const key = `${m.timestamp ?? "?"}:${text.length}`;
			if (consumed.has(key)) break;
			consumed.add(key);
			handleMessage(text, senderOf(m.details));
			break;
		}
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
