# Assembled Intraday notification system

Guidance for AI agents working in this repository.

## Commands

```
npm run replay        # replay data/events.jsonl, print notifications and a summary
npm test              # vitest
npm run check-types   # tsc --noEmit
```

Node runs the `.ts` files directly. Imports need the `.ts` extension, type-only imports need `import type`, and enums and parameter properties are not available.

## Where things are

| Path | What it holds |
| ---- | ------------- |
| `src/shared/` | The `Rule` type and the field catalog (what a rule can test) |
| `src/engine/` | The logic: normalise, apply state, evaluate a rule, step an incident |
| `src/store/` | `schema.sql` and every SQLite read and write |
| `src/ingest.ts` | What happens to one feed line, in order. The only place the engine and the store meet |
| `src/notify/` | Delivery stub (console) |
| `src/replay.ts` | Command-line wrapper around `replayFeed` |
| `tests/` | Vitest suites mirroring `src/`, plus `testHelpers.ts` (real feed lines by number, fixtures) |

## Rules

- `src/engine/` does no I/O and never reads the system clock. Time is passed in. This is what makes a replay give the same result every time and lets the tests assert exact times.
- A new thing a rule can test is a new entry in `src/shared/catalog.ts`, not a new branch in the engine.
- Never edit `data/events.jsonl`. Tests about dirt in the feed read the real line by number (`feedLine(68)`).
- Tests live in `tests/`, mirroring `src/` (`src/engine/foo.ts` → `tests/engine/foo.test.ts`).
- Keep changes narrow: no new dependency, option or abstraction without asking first.
