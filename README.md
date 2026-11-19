# Assembled Intraday notification system

Work in progress. The full writeup (audience, design, tradeoffs, AI usage) lands with the finished system.

## Run it

Needs Node 24.15 or newer. The database (`node:sqlite`) and the TypeScript runner are both built into Node, so there is nothing to compile.

```
npm install
npm run simulate   # open http://localhost:3000, add rules, click "Start feed"; Ctrl-C to stop
npm run replay     # the seeded rules over the feed in one go, printing every notification
npm test
```

## What it does so far

Every line of the sample feed goes through the full path: parse and check it, drop duplicates, set late events aside, update the queue's or agent's state, check the rules that cover it, and write any incident change and its notifications in one transaction. Between events, timers open incidents whose "for" has run out, send follow-ups, and close incidents that have settled.

An incident is one rule being true for one queue or agent. Its owner hears once when it opens, every 15 minutes while it stays open, and once when it closes. A rule on a number (SLA used, tickets waiting) must stay false for 5 minutes before its incident closes, so a value hovering at a threshold does not re-fire. A rule on a state (on a call, out of adherence) closes as soon as the state ends.

`data/rules.seed.json` holds 15 example rules, one per scenario:

- `lead_1` watches every queue: SLA breached, near SLA (80 to 100%), more than 20 waiting.
- Each lead watches their own team (`data/directory.json`): out of adherence for 10 minutes, on a call for 45 minutes.
- Each agent watches themself: out of adherence for 10 minutes.

The replay prints 33 notifications, then the incidents still live when the feed ends. The simulation sends the same 33 up to 10:30, then the ticker carries on (for example, `a_42`'s call opens at 10:33).

## How it runs

In production the system is three functions, all in `src/functions/`. The config API (`api.ts`) saves and lists rules and notifications. The other two call the engine through `src/ingest.ts`:

- **Events webhook** (`events.ts`, `POST /events`). It receives one feed event per request, records it, updates the queue's or agent's state, and checks the rules that cover it. It is the only path that changes state.
- **Scheduled ticker** (`ticker.ts`, every 30 seconds). It fires incident deadlines that came due: an opening once a "for" has run out, a follow-up, a close after settling. Without it, a quiet feed would leave incidents silent.

A deadline can fire up to one tick late; it is still stamped with its due time. If an event for that incident arrives before the tick does, the webhook settles the overdue deadline first, inside the same transaction. That way an agent who comes back into adherence one second after their 10 minutes still gets the opening, and a follow-up reports the numbers from when it came due.

Neither function reads the system clock: each is given "now". In production that is the real clock. The sample feed is dated 2026-05-26, so `scripts/simulate.ts` gives them a simulated clock instead. It starts the webhook as a real HTTP server, posts each line when simulated time reaches it, and runs the ticker every 30 simulated seconds. Time keeps running after the last line, so follow-ups and closes keep arriving from the ticker alone. Each notification is labelled with the function that sent it.

`scripts/replay.ts` runs the same two functions with no server and no waiting, and stops at the feed's last line.

What the simulation does not show: a service on the real clock, several instances at once (that needs a row lock between the webhook and the ticker), or recovery after downtime.

## Creating rules

`npm run simulate` serves a rules page on http://localhost:3000. Pick who you are ("Viewing as": there is no login), and the page shows your rules, a form to add one, and the notifications sent to you.

- **The form** is built from the field catalog and the directory: what to watch (queues, agents or teams; "Me" and "My team" fill it in for you), conditions that must all hold, and how many minutes they must hold for. Notifications go to whoever created the rule.
- **Every rule is checked before it is saved** (`src/shared/validate.ts`): the field exists, the operator suits it (no "above" on a state), the value suits both, and every queue, agent and team is in the directory. A typo like `on_brake` is refused rather than silently never firing. The seeded rules go through the same check.
- **Deleting a rule** stops it being checked and closes its live incidents without a message. Its row stays, so past notifications still say which rule sent them.
- **Nothing plays until "Start feed"**, so rules added first see the whole feed. It runs once; restart the command to run again (rules added on the page are lost on restart). A rule added mid-run applies from its subject's next event.

The same calls work without the page: `GET /directory`, `GET /catalog`, `GET /rules?owner=`, `POST /rules`, `DELETE /rules/:id`, `GET /notifications?recipient=`, and `POST /simulation/start`.

Not built yet: the assistant that fills the form from a sentence.
