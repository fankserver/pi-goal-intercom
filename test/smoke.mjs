/**
 * Regression suite for pi-goal-intercom.
 *
 * Each case below reproduces a defect that actually happened in production on
 * 2026-10-09, so these are not synthetic guesses:
 *
 *   1. A peer's bug report that merely QUOTED the protocol token started a real,
 *      paying goal whose objective was the quoted prose (naive substring match).
 *   2. GOAL:CANCEL was acknowledged before pi-goal answered, so a refused cancel
 *      was reported as "sent" and the sender retried into GOAL_ALREADY_EXISTS.
 *   3. A stopped (budget_limited) goal keeps the slot; replies must say so and
 *      name the recovery that preserves progress.
 *
 * Drives the shipped dist/index.ts with a fake ExtensionAPI plus a fake pi-goal
 * Managed Run RPC, so no real pi session or model call is involved.
 *
 * Run with: node test/smoke.mjs   (after `npm run build`)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sandboxDir = mkdtempSync(join(tmpdir(), "pgi-test-"));
process.env.PI_GOAL_INTERCOM_LOG = join(sandboxDir, "test.log");
// The acted-on record is file-backed so it survives resume; keep the suite off the
// real ~/.pi and let boots share one store the way sibling sessions do. Must be set
// before dist/index.ts is first imported, because STATE_DIR is read at module load.
process.env.PI_GOAL_INTERCOM_STATE_DIR = sandboxDir;

const root = new URL("..", import.meta.url);
const distPath = new URL("dist/index.ts", root);
const dist = fileURLToPath(distPath);

let failures = 0;
function check(ok, label, detail = "") {
	if (ok) {
		console.log(`ok: ${label}`);
		return;
	}
	failures += 1;
	console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
}

/* ------------------------------------------------------------------ build */

const source = readFileSync(dist, "utf8");
if (!/export default function\s+goalIntercom\b/.test(source)) {
	throw new Error("dist/index.ts does not export the expected default factory");
}
console.log("ok: dist/index.ts has the goalIntercom default factory");

const mod = await import(distPath.href);
const goalIntercom = mod.default;
const { parseCommand } = mod;
check(typeof goalIntercom === "function", "default export is a factory");
check(typeof parseCommand === "function", "parseCommand is exported");

const START_CHANNEL = "pi-goal:start";
const CANCEL_CHANNEL = "pi-goal:cancel";
const OUTBOX = "intercom:outbox-request";
const eventChannel = (runId) => `pi-goal:event:${runId}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------- fake harness */

function makePi(sessionName = "test-1") {
	const handlers = new Map();
	const listeners = new Map();
	const emitted = [];
	return {
		on(event, fn) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		events: {
			on(channel, fn) {
				if (!listeners.has(channel)) listeners.set(channel, new Set());
				listeners.get(channel).add(fn);
				return () => listeners.get(channel)?.delete(fn);
			},
			emit(channel, data) {
				emitted.push({ channel, data });
				for (const fn of [...(listeners.get(channel) ?? [])]) fn(data);
			},
		},
		getSessionName: () => sessionName,
		_handlers: handlers,
		_emitted: emitted,
	};
}

/**
 * Mirrors the real pi-goal Managed Run RPC decision branches, including the one
 * that caused the outage: cancel is honoured only while the goal is "active"
 * (run-protocol.ts:291), while a stopped goal still blocks new starts (:201).
 */
function attachFakeGoal(pi, options = {}) {
	const state = { goal: undefined, starts: [], cancels: [] };
	pi.events.on(START_CHANNEL, (data) => {
		state.starts.push(data);
		if (options.rejectStart) {
			pi.events.emit(eventChannel(data.runId), {
				type: "error",
				runId: data.runId,
				operation: "start",
				error: { code: "GOAL_ALREADY_EXISTS", message: "A Goal already exists." },
			});
			return;
		}
		state.goal = { runId: data.runId, status: "active", budget: data.tokenBudget };
		pi.events.emit(eventChannel(data.runId), {
			type: "state",
			runId: data.runId,
			goalId: `g-${data.runId}`,
			status: "active",
		});
	});
	pi.events.on(CANCEL_CHANNEL, (data) => {
		state.cancels.push(data);
		const goal = state.goal;
		if (!goal || goal.runId !== data.runId) {
			pi.events.emit(eventChannel(data.runId), {
				type: "error",
				runId: data.runId,
				operation: "cancel",
				error: { code: "RUN_NOT_FOUND", message: "No active managed run matches runId." },
			});
			return;
		}
		if (goal.status !== "active") {
			pi.events.emit(eventChannel(data.runId), {
				type: "error",
				runId: data.runId,
				operation: "cancel",
				error: { code: "RUN_NOT_FOUND", message: "The managed run is no longer active." },
			});
			return;
		}
		goal.status = "paused";
		pi.events.emit(eventChannel(data.runId), {
			type: "state",
			runId: data.runId,
			goalId: `g-${data.runId}`,
			status: "paused",
			reason: data.reason,
		});
	});
	return state;
}

/** A live delivery: fresh delivery id and a current injection stamp. */
function envelope(from, body) {
	return rawEnvelope(from, randomUUID(), new Date().toISOString(), body);
}

function rawEnvelope(from, id, injectedAt, body) {
	return `**From ${from}** (/home/dev/project)\n\n_id ${id} · seq 7 · sent ${injectedAt} · injected ${injectedAt}_\n\n${body}`;
}

/**
 * Re-stamp archived traffic as a live delivery, so a test that means "this arrived
 * now" is not accidentally testing the replay gate.
 */
function freshen(text) {
	const now = new Date().toISOString();
	return text
		.replace(/_id\s+[0-9a-f][0-9a-f-]{7,39}/u, `_id ${randomUUID()}`)
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, now);
}

/** Archive the same text as an hours-old delivery, which is what a resume replays. */
function archive(text, ageMs = 6 * 60 * 60 * 1000) {
	const old = new Date(Date.now() - ageMs).toISOString();
	return text
		.replace(/_id\s+[0-9a-f][0-9a-f-]{7,39}/u, `_id ${randomUUID()}`)
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, old);
}

async function boot(sessionName = "test-1") {
	const pi = makePi(sessionName);
	goalIntercom(pi);
	const goal = attachFakeGoal(pi);
	const deliverRaw = async (content, from = "peer-coordinator") => {
		const message = {
			role: "custom",
			customType: "intercom_message",
			content,
			timestamp: Date.now() + Math.random(),
			details: { from: { name: from, id: "01a10c38-837a-717e" } },
		};
		for (const fn of pi._handlers.get("context") ?? []) await fn({ messages: [message] });
		await flush();
	};
	const deliver = (body, from = "peer-coordinator") => deliverRaw(envelope(from, body), from);
	/** One scan over several messages, which is what a real `context` event is. */
	const deliverMany = async (contents, from = "peer-coordinator") => {
		const list = contents.map((content, i) => ({
			role: "custom",
			customType: "intercom_message",
			content,
			timestamp: Date.now() + i,
			details: { from: { name: from, id: "01a10c38-837a-717e" } },
		}));
		for (const fn of pi._handlers.get("context") ?? []) await fn({ messages: list });
		await flush();
	};
	const replies = () =>
		pi._emitted
			.filter((e) => e.channel === OUTBOX)
			.map((e) => String(e.data?.message ?? ""));
	const starts = () => pi._emitted.filter((e) => e.channel === START_CHANNEL).map((e) => e.data);
	const cancels = () => pi._emitted.filter((e) => e.channel === CANCEL_CHANNEL).map((e) => e.data);
	return { pi, goal, deliver, deliverRaw, deliverMany, replies, starts, cancels };
}

/**
 * Drive the fake into a stopped state the way the real session did — updating the
 * fake's own goal status as well as publishing the event, otherwise the fake
 * still believes the goal is active and would honour a cancel it must refuse.
 */
function driveStatus(t, runId, status, reason) {
	if (t.goal.goal?.runId === runId) t.goal.goal.status = status;
	t.pi.events.emit(eventChannel(runId), {
		type: "state",
		runId,
		goalId: `g-${runId}`,
		status,
		...(reason ? { reason } : {}),
	});
	return new Promise((resolve) => setImmediate(resolve));
}

/* --------------------------------------------- 1. command grammar (incident) */

const INCIDENT_BODY = [
	"test-1 — pi-goal-intercom BUG REPORT (from peer-coordinator, full detail so you can fix).",
	"",
	"**BUG 1 — `--tokens` budget is measured against the session's PRE-EXISTING context, not the goal's marginal spend.**",
	"Fired `GOAL:START <objective> --tokens 40000` (and 60000) against long-lived warmed sessions already holding 140k–235k of conversation context.",
	"- Expected: `GOAL:CANCEL` must terminate (or at least clear) the existing goal object so a new GOAL:START succeeds.",
].join("\n");

check(parseCommand(INCIDENT_BODY) === undefined, "quoted protocol prose in a report is NOT a command");
check(
	parseCommand("Please run GOAL:START something now") === undefined,
	"marker mid-sentence is NOT a command",
);
check(
	parseCommand("```\nGOAL:START sneaky\n```") === undefined,
	"marker inside a fenced block is NOT a command",
);
check(parseCommand("> GOAL:START quoted reply") === undefined, "marker in a blockquote is NOT a command");
check(
	parseCommand("- GOAL:START bulleted") === undefined,
	"marker on a bullet line is NOT a command",
);
check(parseCommand("GOAL:STARTTYPE no-space") === undefined, "marker must be a whole word");
check(parseCommand("Some chatter") === undefined, "ordinary prose is not a command");

check(
	parseCommand(envelope("peer", "GOAL:START ship the readme --tokens 300000"))?.kind === "START",
	"command in position after the intercom envelope IS recognised",
);
{
	const cmd = parseCommand(envelope("peer", "GOAL:START ship the readme --tokens 300000"));
	check(cmd?.argument === "ship the readme --tokens 300000", "objective and budget survive envelope stripping", JSON.stringify(cmd));
}
{
	const cmd = parseCommand(envelope("peer", "GOAL:START multi line\nsecond line of objective"));
	check((cmd?.argument ?? "").includes("second line"), "multi-line objective is preserved");
}
check(parseCommand(envelope("peer", "GOAL:CANCEL owner changed"))?.kind === "CANCEL", "cancel recognised");
check(parseCommand(envelope("peer", "GOAL:STATUS"))?.kind === "STATUS", "status recognised");

/* ------------------------------------- 2. replay of the traffic that caused it */

/*
 * Shape-faithful reproductions of the traffic that caused the 2026-10-09 outage,
 * with identifiers redacted (see test/fixtures/README.md): the pi-intercom
 * envelope, markers quoted inside backticks mid-line, bullets, blockquotes,
 * fenced blocks, and `--tokens` suffixes are preserved because that shape is what
 * regressed.
 *   negative — reports that only *describe* the protocol. Correct outcome: none
 *     of them is a command.
 *   positive — genuine commands with the same envelope. Correct outcome: they
 *     still parse, so the fix cannot degrade into "never fire".
 */
const negFixture = JSON.parse(
	readFileSync(new URL("test/fixtures/test1-inbound-intercom.json", root), "utf8"),
);
const posFixture = JSON.parse(
	readFileSync(new URL("test/fixtures/implementer1-legit-goal-commands.json", root), "utf8"),
);

check(negFixture.length > 0, "negative fixture present", `${negFixture.length} messages`);
check(posFixture.length > 0, "positive fixture present", `${posFixture.length} commands`);
check(
	negFixture.some((t) => /GOAL:(START|CANCEL|STATUS)/.test(t)),
	"negative fixture really contains quoted protocol tokens",
);
check(
	negFixture.every((t) => parseCommand(t) === undefined),
	"every real test-1 message parses as non-command",
);

{
	const t = await boot();
	// Re-stamped as live deliveries: these must be stopped by the PARSER, not by
	// the replay age gate, or the test would pass for the wrong reason.
	for (const content of negFixture) await t.deliverRaw(freshen(content));
	check(t.starts().length === 0, "replaying all real test-1 traffic starts no goal");
	check(t.replies().length === 0, "replaying all real test-1 traffic sends no reply");
}

{
	// Positive control against the same parser.
	const kinds = posFixture.map((t) => parseCommand(t)?.kind);
	check(
		kinds.every((k) => ["START", "CANCEL", "STATUS"].includes(k)),
		"genuine commands still parse",
		JSON.stringify(kinds),
	);
	// The coordinator's real traffic passed `--tokens 300000`, which is above the
	// floor: those starts must be honoured, because dropping a requested ceiling would
	// run past the spend the sender authorized.
	const flagged = posFixture.filter(
		(t) => parseCommand(t)?.kind === "START" && /(?:^|\s)--tokens\s+\d+\s*$/u.test(String(parseCommand(t)?.argument)),
	);
	const expectedStarts = kinds.filter((k) => k === "START").length;
	check(flagged.length === 2, "fixture really contains budget-carrying starts", String(flagged.length));
	const t = await boot();
	for (const content of posFixture) await t.deliverRaw(freshen(content));
	check(
		t.starts().length === expectedStarts,
		"real commands still start the expected number of goals",
		`${t.starts().length} started, expected ${expectedStarts}`,
	);
	check(
		t.starts().filter((x) => x.tokenBudget !== undefined).every((x) => x.tokenBudget === 300000) &&
			t.starts().filter((x) => x.tokenBudget !== undefined).length === flagged.length,
		"each above-floor budget is forwarded intact and only where asked",
		JSON.stringify(t.starts().map((x) => x.tokenBudget)),
	);
	check(t.cancels().length > 0, "real cancel commands still dispatch a cancel");
	// A forwarded objective must be the task itself, never quoted report prose.
	check(
		t.starts().every((s) => String(s.objective).length > 20 && !/BUG REPORT|RETRANSMIT|auto-ack/i.test(String(s.objective))),
		"forwarded objectives are genuine task text, not quoted prose",
		JSON.stringify(t.starts().map((s) => String(s.objective).slice(0, 40))),
	);
	check(
		t.starts().every((s) => "tokenBudget" in s ? s.tokenBudget >= 150000 : true),
		"no start ever carries a sub-floor budget",
		JSON.stringify(t.starts().map((s) => s.tokenBudget)),
	);
}

/* ---------------------------------------------------- 3. honest cancel (bug 2) */

{
	const t = await boot();
	await t.deliver("GOAL:START observe the CI run until terminal");
	check(t.starts().length === 1, "legitimate start emits exactly one managed start");
	check(!("tokenBudget" in (t.starts()[0] ?? {})), "no budget forwarded to pi-goal", JSON.stringify(t.starts()[0]));
	check(t.replies().some((r) => r.includes("GOAL active")), "active acknowledged");

	// Exhaust the budget the way the real session did, then cancel it.
	await driveStatus(t, t.starts()[0].runId, "budget_limited", "token budget reached (175.8k/40k)");
	const budgetReply = t.replies().at(-1) ?? "";
	check(budgetReply.includes("budget_limited"), "budget exhaustion reported");
	check(budgetReply.includes("/goal edit --tokens"), "recovery names the progress-preserving fix");
	check(budgetReply.includes("Do NOT run `/goal clear`"), "recovery warns against destroying progress");

	const before = t.replies().length;
	await t.deliver("GOAL:CANCEL budget too low, re-sending with a proper budget");
	const after = t.replies().slice(before);
	check(after.length === 1, "cancel produced exactly one reply");
	const cancelReply = after[0] ?? "";
	check(cancelReply.includes("refused"), "a refused cancel is reported as refused, not sent");
	check(!cancelReply.includes("sent for run"), "no false 'CANCEL sent' acknowledgement");
	check(cancelReply.includes("worker-1") || cancelReply.includes("test-1"), "hint names the session needing a human");
	check(t.cancels().length === 1, "cancel was dispatched once");
}

/* ---------------------------------- 4. cancel of a live goal is confirmed real */

{
	const t = await boot();
	await t.deliver("GOAL:START watch the pipeline");
	await t.deliver("GOAL:CANCEL owner redirected");
	const last = t.replies().at(-1) ?? "";
	check(last.includes("GOAL cancelled") && last.includes("paused"), "live cancel confirms the real status", last);
	check(t.goal.goal?.status === "paused", "fake goal really transitioned to paused");
}

/* ---------------------------------------------------- 5. GOAL:STATUS detection */

{
	const t = await boot();
	await t.deliver("GOAL:START observe CI");
	const runId = t.starts()[0].runId;
	await driveStatus(t, runId, "budget_limited", "token budget reached");
	const before = t.replies().length;
	await t.deliver("GOAL:STATUS");
	const status = t.replies().slice(before).join("\n");
	check(status.includes("STUCK"), "status exposes the stuck slot instead of guessing");
	check(status.includes("budget_limited"), "status reports the last status pi-goal gave");
}

/* ------------------------------------------- 6. start rejection is actionable */

{
	const pi = makePi("test-1");
	goalIntercom(pi);
	const goal = attachFakeGoal(pi, { rejectStart: true });
	const deliverLocal = async (body) => {
		const message = {
			role: "custom",
			customType: "intercom_message",
			content: envelope("peer-coordinator", body),
			timestamp: Date.now() + Math.random(),
			details: { from: { name: "peer-coordinator", id: "01a10c38-837a-717e" } },
		};
		for (const fn of pi._handlers.get("context") ?? []) await fn({ messages: [message] });
		await flush();
	};
	await deliverLocal("GOAL:START first objective");
	await deliverLocal("GOAL:START second objective");
	const replies = pi._emitted
		.filter((e) => e.channel === OUTBOX)
		.map((e) => String(e.data?.message ?? ""));
	check(
		replies.some((r) => r.includes("GOAL:START rejected (GOAL_ALREADY_EXISTS)")),
		"rejection is reported with its code",
	);
	check(
		replies.some((r) => r.includes("/goal clear") || r.includes("genuinely active")),
		"rejection tells the dispatcher what to do next",
		replies.at(-1),
	);
}

/* --------------------------------- 6b. optional replay of real local traffic */

/*
 * `node scripts/make-fixtures.mjs <session.jsonl> …` writes a redacted replay of
 * genuine transcripts to test/fixtures/local/ (gitignored, so nothing internal
 * reaches this public repository). When present it is replayed here; when absent
 * the committed shape fixtures above still guard the regression.
 */
{
	const local = [];
	for (const name of ["negative.json", "positive.json"]) {
		try {
			local.push(...JSON.parse(readFileSync(new URL(`test/fixtures/local/${name}`, root), "utf8")));
		} catch {
			/* not generated on this machine */
		}
	}
	if (local.length) {
		const commands = local.filter((t) => parseCommand(t) !== undefined);
		const t = await boot();
		for (const content of local) await t.deliverRaw(freshen(content));
		check(t.starts().length === commands.length, `local replay: ${local.length} messages, ${commands.length} commands honoured`);
		console.log(`ok: replayed ${local.length} local transcript messages`);
	} else {
		console.log("skip: no local transcript replay (run scripts/make-fixtures.mjs to generate)");
	}
}

/* ------------------------------- 6a. resume must not re-execute a command */

/*
 * The incident this guards: a session restarted at 16:24 and its `context` handler
 * re-saw a genuine `GOAL:START` from 14:02 in the replayed history. The old dedupe
 * key was in-memory only, so the command looked new and the session spent 72
 * seconds of paid turns re-running an objective that had finished hours earlier.
 */
{
	// Index 4 is the coordinator's one objective with no trailing budget flag, so it is
	// expected to start; index 0 carries a budget and is refused.
	const fixture = JSON.parse(
		readFileSync(new URL("test/fixtures/implementer1-legit-goal-commands.json", root), "utf8"),
	);
	const genuine = fixture[4];

	// Replayed history: same command text, hours-old delivery stamp.
	const t = await boot();
	await t.deliverRaw(archive(genuine));
	check(t.starts().length === 0, "replayed history command starts no goal", JSON.stringify(t.starts()));
	check(t.replies().length === 0, "replayed history command sends no acknowledgement", JSON.stringify(t.replies()));

	// Same archived stamp, but a command that was never acted on and carries no
	// envelope at all: the age gate is the only thing that can catch it, so prove
	// the gate is not simply "no stamp means block".
	const t2 = await boot();
	await t2.deliverRaw(genuine.replace(/^\*\*From[\s\S]*?_\n\n/u, ""));
	check(t2.starts().length === 1, "an unstamped live command still fires", "parser must not require an envelope");
}

/* --------------------------- 6b. acted-on record survives a session restart */

/*
 * Fresh boot, empty in-memory set, same delivery id already in the file-backed
 * record, and stamps re-written to now so the age gate cannot be what saves us.
 * This isolates the durable guard, which is the one that catches a replay whose
 * envelope was re-stamped by the broker.
 */
{
	const t = await boot();
	const text = envelope("peer-coordinator", "GOAL:START durable-guard-check: reply OK and stop");
	await t.deliverRaw(text);
	const firstStarts = t.starts().length;
	const after = await boot();
	await after.deliverRaw(text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, new Date().toISOString()));
	check(
		firstStarts === 1 && after.starts().length === 0,
		"a command already acted on is not re-executed after a restart",
		JSON.stringify({ firstStarts, secondStarts: after.starts().length }),
	);

	// And a genuinely new command after that restart must still fire.
	await after.deliver("GOAL:START new-after-restart: reply OK and stop");
	check(after.starts().length === 1, "a new command after a restart still fires", JSON.stringify(after.starts()));

	// The record is bounded and stays valid JSON on disk.
	const store = JSON.parse(readFileSync(join(process.env.PI_GOAL_INTERCOM_STATE_DIR, "pi-goal-intercom-processed.json"), "utf8"));
	check(Array.isArray(store.keys) && store.keys.length >= 2 && store.keys.every((k) => k.includes("|")), "acted-on record is durable, session-scoped JSON", JSON.stringify(store.keys?.slice(0, 2)));
}

/* --------------- 6c. two commands arriving together must BOTH be honoured */

/*
 * A `context` event carries the whole history, so when two commands land between
 * prompt builds the extension sees them in one scan. Walking newest-first and
 * stopping at the first hit meant only the newer one ever ran: the next scan met
 * the newer command already in the dedupe set, stopped there, and the queued older
 * command was unreachable forever.
 */
{
	const t = await boot();
	const statusMsg = envelope("peer-coordinator", "GOAL:STATUS");
	const startMsg = envelope(
		"peer-coordinator",
		"GOAL:START queued-pair: reply OK and stop",
	);
	await t.deliverMany([statusMsg, startMsg]);
	check(t.starts().length === 1, "queued START dispatched", JSON.stringify(t.starts()));
	check(
		t.replies().some((r) => r.includes("GOAL:STATUS")),
		"queued STATUS not starved by the newer START",
		JSON.stringify(t.replies()),
	);

	// Oldest first, so the operator sees the status answer before the start ack.
	await driveStatus(t, t.starts()[0].runId, "active");
	const statusIdx = t.replies().findIndex((r) => r.includes("GOAL:STATUS"));
	const activeIdx = t.replies().findIndex((r) => r.includes("GOAL active"));
	check(
		statusIdx >= 0 && activeIdx > statusIdx,
		"queued commands dispatched oldest-first",
		JSON.stringify({ statusIdx, activeIdx }),
	);

	// Re-scanning the same history runs neither again.
	await t.deliverMany([statusMsg, startMsg]);
	check(t.starts().length === 1, "re-scan re-runs neither queued command", JSON.stringify(t.starts()));
}

/* --------------------------------------- 6d. budgets are optional, discouraged, floored */

/*
 * An explicit ceiling is honoured (dropping one would exceed what the sender
 * authorized), but the parameter's failure mode is a jammed slot rather than a clean
 * stop, and skill prose once actively invited the flag — coordinators obliged and four
 * sessions stuck at 40k/60k. So the protection is a floor in code, not a warning in
 * documentation.
 */
{
	const t = await boot();

	// The observed jam values, replayed: both must be refused, not honoured.
	for (const low of [40000, 60000, 149999]) {
		await t.deliver(`GOAL:START observe CI run until terminal --tokens ${low}`);
	}
	check(t.starts().length === 0, "sub-floor budgets dispatch nothing", JSON.stringify(t.starts()));
	const refusal = t.replies()[0] ?? "";
	check(refusal.includes("BUDGET_TOO_LOW"), "refusal names the code", refusal.slice(0, 60));
	check(refusal.includes("floor"), "refusal explains the floor", refusal.slice(0, 80));
	check(
		refusal.includes("omitting --tokens") && refusal.includes("no-progress"),
		"refusal recommends the unbudgeted path and names the real brake",
		refusal.slice(80, 220),
	);
	check(
		refusal.includes("/goal edit --tokens") || refusal.includes("human must raise"),
		"refusal discloses that exhaustion needs a human",
		refusal.slice(-160),
	);

	// At and above the floor the sender's ceiling is honoured exactly.
	await t.deliver("GOAL:START observe CI run until terminal --tokens 150000");
	check(t.starts().length === 1, "an at-floor budget is honoured", JSON.stringify(t.starts()));
	check(t.starts()[0]?.tokenBudget === 150000, "the floor boundary is inclusive", JSON.stringify(t.starts()[0]));

	// A malformed value is not silently treated as "no budget" — that would run
	// unbounded past the ceiling the sender tried to set.
	const before = t.starts().length;
	await t.deliver("GOAL:START observe CI run until terminal --tokens abc");
	check(t.starts().length === before, "a malformed budget does not start an unbounded run", JSON.stringify(t.starts()));
	check(
		(t.replies().at(-1) ?? "").includes("positive whole number"),
		"a malformed budget is reported, not ignored",
		(t.replies().at(-1) ?? "").slice(0, 70),
	);

	// No flag at all remains the clean path.
	await t.deliver("GOAL:START plain long horizon objective");
	check(
		t.starts().length === before + 1 && !("tokenBudget" in t.starts().at(-1)),
		"omitting the flag starts with no budget",
		JSON.stringify(t.starts().at(-1)),
	);

	// A protocol mention inside the objective is prose, not a flag.
	await t.deliver("GOAL:START document the --tokens flag and its removal in the changelog");
	const prose = t.starts().at(-1);
	check(
		String(prose?.objective).includes("--tokens") && !("tokenBudget" in (prose ?? {})),
		"a prose mention of the flag is not mistaken for a budget",
		JSON.stringify(prose),
	);

	// Choosing a budget discloses what was chosen, at the moment of choosing.
	await t.deliver("GOAL:START bounded objective with a real ceiling --tokens 400000");
	await driveStatus(t, t.starts().at(-1).runId, "active");
	const ack = t.replies().at(-1) ?? "";
	check(
		ack.includes("400,000") && ack.includes("cumulative") && ack.includes("human"),
		"the ack discloses the budget is cumulative and human-bounded",
		ack.slice(0, 160),
	);
}

/* -------------------------------------------------------- 7. scope gate holds */

{
	const t = await boot("worker-1");
	await t.deliver("GOAL:START should never run here");
	check(t.starts().length === 0, "a session outside the gate stays inert");
	check(t.replies().length === 0, "out-of-scope session stays silent");
}

if (failures > 0) {
	throw new Error(`${failures} regression check(s) failed`);
}
console.log("\nsmoke ok: all regression checks passed");
