/**
 * Regenerate the replay fixtures from local pi session transcripts, with
 * identifying information removed.
 *
 * The fixtures must keep the SHAPE of real traffic — pi-intercom envelope,
 * quoted markers inside backticks mid-line, bullets, blockquotes, `--tokens`
 * suffixes — because that shape is what the regression tests. Identifiers
 * (repo, PR numbers, CI run ids, commit SHAs, session aliases, home paths) are
 * replaced deterministically so nothing internal reaches this public repository.
 *
 * Usage: node scripts/make-fixtures.mjs <session.jsonl> [...]
 * Run `node test/smoke.mjs` afterwards to confirm the replay still holds.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const OUT_NEG = "test/fixtures/local/negative.json";
const OUT_POS = "test/fixtures/local/positive.json";

const PROJECT = process.env.PGI_PROJECT ?? "project";
const TICKET = process.env.PGI_TICKET ?? "TICKET";
const prMap = new Map();
function prNumber() {
	const next = 1001 + prMap.size;
	return (n) => {
		if (!prMap.has(n)) prMap.set(n, String(next));
		return `#${prMap.get(n)}`;
	};
}

function redact(text) {
	const pr = prNumber();
	return text
		.replace(new RegExp(`/tmp/${PROJECT}-operator-[A-Za-z0-9._-]+`, "g"), "/tmp/operator")
		.replace(/\/home\/[A-Za-z0-9._-]+\/repo\/[A-Za-z0-9._-]+/g, "/home/dev/project")
		.replace(/\/home\/[A-Za-z0-9._-]+\/work\/[A-Za-z0-9._-]+/g, "/home/dev/clone-1")
		.replace(/\/home\/[A-Za-z0-9._-]+\/coordination/g, "/home/dev/coordination")
		.replace(/\/home\/[A-Za-z0-9._-]+/g, "/home/dev")
		.replace(new RegExp(`[A-Za-z0-9._-]+/${PROJECT}`, "g"), "example/project")
		.replace(new RegExp(`\\b${PROJECT}\\b`, "g"), "example")
		.replace(new RegExp(`\\b${TICKET}-`, "g"), "TEAM-")
		.replace(new RegExp(`\\b${TICKET}\\b`, "g"), "PROJ")
		.replace(/\bbugfixer-(\d)/g, "worker-$1")
		.replace(/\bimplementer-(\d)/g, "worker-$1")
		.replace(/\bimpl-(\d)/g, "worker-$1")
		.replace(/\b[0-9a-f]{40}\b/g, "0".repeat(40))
		.replace(/\b\d{11}\b/g, "12345678901")
		.replace(/#(\d{4})\b/g, (_, n) => pr(n));
}

const messages = [];
for (const file of process.argv.slice(2)) {
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "custom_message" || entry?.customType !== "intercom_message") continue;
		const content = entry.bodyText ?? entry.content;
		if (typeof content === "string") messages.push(redact(content));
	}
}

const negative = [...new Set(messages.filter((m) => !/\nGOAL:(START|CANCEL|STATUS) /.test(m)))];
const positive = [...new Set(messages.filter((m) => /\nGOAL:(START|CANCEL|STATUS) /.test(m)))];
mkdirSync("test/fixtures/local", { recursive: true });
writeFileSync(OUT_NEG, `${JSON.stringify(negative, null, 2)}\n`);
writeFileSync(OUT_POS, `${JSON.stringify(positive, null, 2)}\n`);
console.log(`wrote ${negative.length} non-command and ${positive.length} command messages`);
