# Test fixtures

Shape-faithful reproductions of the intercom traffic that caused the 2026-10-09
incident, with **identifiers redacted**: session aliases, repo/PR numbers, CI run
ids, commit SHAs, and home paths are replaced with neutral placeholders. What is
preserved deliberately is the *shape*, because that is what regressed — the
pi-intercom delivery envelope, protocol markers quoted inside backticks mid-line,
bullet and blockquote prefixes, fenced code blocks, and `--tokens` suffixes.

- `test1-inbound-intercom.json` — messages that only *describe* the protocol.
  None may be treated as a command. These mirror the bug reports that a naive
  substring matcher turned into a real, paying goal.
- `implementer1-legit-goal-commands.json` — genuine commands using the same
  envelope. All must still parse, so the parser cannot pass by never firing.

## Replaying real traffic locally

To check the parser against actual transcripts, generate a **redacted** replay
into `test/fixtures/local/` (gitignored — never commit real transcripts here):

```bash
node scripts/make-fixtures.mjs ~/.pi/agent/sessions/<dir>/<session>.jsonl
node test/smoke.mjs
```

Review the generated files before running anything that shares them; the
redaction is best-effort pattern matching, not a guarantee.
