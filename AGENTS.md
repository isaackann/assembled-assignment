# Assembled Intraday notification system

Guidance for AI agents working in this repository.

## Commands

```
npm run replay        # replay data/events.jsonl in one go, print notifications and a summary
npm run simulate      # builds web/, serves the page + API + webhook on :3000; "Start feed" plays data/events.jsonl at 60x
npm test              # vitest
npm run check-types   # tsc --noEmit, for the server and for web/
```

Node runs the `.ts` files directly. Imports need the `.ts` extension, type-only imports need `import type`, and enums and parameter properties are not available.

## Where things are

| Path | What it holds |
| ---- | ------------- |
| `src/shared/` | The `Rule` type, the field catalog (what a rule can test, its label, operators per type, allowed values), the directory shape, `validateRule` |
| `src/engine/` | The logic: normalise, apply state, evaluate a rule, step an incident's lifecycle, word its messages |
| `src/store/` | `schema.sql` and every SQLite read and write |
| `src/ingest.ts` | `handleEvent` (one event arrived) and `tick` (time passed). The only place the engine and the store meet |
| `src/functions/` | The deployed functions: the config API (`api.ts`), the events webhook (`events.ts`), the scheduled ticker (`ticker.ts`), plus the `Clock` they read "now" from |
| `src/notify/` | Delivery stub (console) |
| `scripts/replay.ts` | Runs the feed through `tick` + `handleEvent` with no server or waiting; `replayFeed`, `arrivals`, `seededStore` |
| `scripts/simulate.ts` | One HTTP server (config API, webhook, page, and the simulation-only start control) and the ticker every 30 s, on a simulated clock |
| `web/` | The rules page (React, built by Vite into `web/dist`). Imports its types from `src/shared/` |
| `data/` | The sample feed, the seeded directory (teams), the seeded rules |
| `tests/` | Vitest suites mirroring `src/`, plus `testHelpers.ts` (real feed lines by number, fixtures) |

## Rules

- `src/engine/` does no I/O and never reads the system clock. Time is passed in. This is what makes a replay give the same result every time and lets the tests assert exact times.
- A new thing a rule can test is a new entry in `src/shared/catalog.ts`, not a new branch in the engine.
- Times that fire between events (opening after a "for", follow-ups, closing after settle) are timers on the incident (`next_due_at`), fired by the scheduled tick (`tick` in `ingest.ts`) and stamped with their due time. `handleEvent` does not tick: it only settles an overdue deadline on an incident it is about to change, in the same transaction.
- Neither function reads the system clock: each is given a `Clock`. The scripts pass a simulated one because the sample feed is dated 2026-05-26.
- `SAMPLE_EXPECTED` in `tests/testHelpers.ts` holds the expected notifications for the sample feed, worked out by hand; `tests/replay.test.ts` and `tests/simulate.test.ts` check against it. Change it only when the intended behaviour changes, never to match new output.
- Never edit `data/events.jsonl`. Tests about dirt in the feed read the real line by number (`feedLine(68)`).
- Tests live in `tests/`, mirroring `src/` (`src/engine/foo.ts` → `tests/engine/foo.test.ts`).
- Every rule from outside (API, seeds, later the assistant) goes through `validateRule` before it is saved. A rule that passes must evaluate without throwing.
- Rules are soft-deleted (`deleted_at`): incidents and notifications keep pointing at them.
- Keep changes narrow: no new dependency, option or abstraction without asking first.
