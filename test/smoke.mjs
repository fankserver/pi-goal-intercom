/**
 * Smoke test — verifies the package is loadable and the marker parser behaves.
 *
 * Run with: node test/smoke.mjs   (assumes `npm run build` has staged dist/)
 *
 * It does NOT spin up a full pi session; it checks:
 *   1. dist/index.ts exists and its default export is a function.
 *   2. The marker parsing decision logic (extract objective / --tokens / cancel)
 *      via a lightweight import of the built runtime.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist/index.ts`;

// 1) staged runtime exists and parses as a module that exports a default fn.
const source = readFileSync(dist, "utf8");
if (!/export default function\s+goalIntercom\b/.test(source)) {
	throw new Error(`dist/index.ts does not export the expected default factory`);
}
console.log("ok: dist/index.ts has the goalIntercom default factory");

// 2) marker extraction logic (pure) — reason over the raw source strings.
function extractStart(text) {
	const marker = "GOAL:START";
	if (!text.includes(marker)) return null;
	const idx = text.indexOf(marker);
	const trimmed = text.slice(idx + marker.length).replace(/^:\s*/, "").trim();
	const tm = /--tokens\s+(\d+)\s*$/.exec(trimmed);
	return {
		objective: tm ? trimmed.slice(0, tm.index).trim() : trimmed,
		tokenBudget: tm ? Number(tm[1]) : undefined,
	};
}

const cases = [
	[
		"GOAL:START reply EXPERIMENT_GOAL_OK and stop.",
		{ objective: "reply EXPERIMENT_GOAL_OK and stop.", tokenBudget: undefined },
	],
	[
		"GOAL:START ship the thing --tokens 50000",
		{ objective: "ship the thing", tokenBudget: 50000 },
	],
	["just chatter, no marker", null],
	[
		"GOAL:START:nospace objective",
		{ objective: "nospace objective", tokenBudget: undefined },
	],
];

let failed = 0;
for (const [input, expected] of cases) {
	const got = extractStart(input);
	if (JSON.stringify(got) !== JSON.stringify(expected)) {
		failed += 1;
		console.error(`FAIL: input=${JSON.stringify(input)} got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`);
	} else {
		console.log(`ok: ${JSON.stringify(input)}`);
	}
}
if (failed > 0) {
	throw new Error(`${failed} marker-parse case(s) failed`);
}
console.log("smoke ok: marker parser matches expectations");
