/**
 * Build script — stages the loadable runtime.
 *
 * pi-goal-intercom ships as a plain single-file TypeScript extension, so the
 * "build" does two things:
 *   1. Verifies the source transpiles and bundles cleanly (esbuild, dev-only).
 *   2. Stages dist/index.ts (real TypeScript) as the runtime Pi loads via jiti,
 *      so an installed checkout is always loadable without a dev dependency.
 *
 * Run with: node scripts/build-runtime.mjs
 */
import { mkdirSync, copyFileSync } from "node:fs";
import { buildSync } from "esbuild";

const SRC = "src/index.ts";
const DIST = "dist/index.ts";

buildSync({
	entryPoints: [SRC],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "es2022",
	outfile: "/tmp/pi-goal-intercom-check.mjs",
	logLevel: "error",
	// The host provides these to extensions; never bundle them.
	external: [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
	],
});

mkdirSync("dist", { recursive: true });
copyFileSync(SRC, DIST);
console.log(`build ok -> ${DIST}`);
