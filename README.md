# Assembled Intraday notification system

Work in progress. The full writeup (audience, design, tradeoffs, AI usage) lands with the finished system.

## Run it

Needs Node 24.15 or newer. The database (`node:sqlite`) and the TypeScript runner are both built into Node, so there is nothing to compile.

```
npm install
npm run replay     # replay data/events.jsonl and print the notifications it fires
npm test
```

## What it does so far

Every line of the sample feed goes through the full path: parse and check it, drop duplicates, set late events aside, update the queue's or agent's state, check the rules that cover it, and write any incident change and its notifications in one transaction. Between events, timers open incidents whose "for" has run out, send follow-ups, and close incidents that have settled.

An incident is one rule being true for one queue or agent. Its owner hears once when it opens, every 15 minutes while it stays open, and once when it closes. A rule on a number (SLA used, tickets waiting) must stay false for 5 minutes before its incident closes, so a value hovering at a threshold does not re-fire. A rule on a state (on a call, out of adherence) closes as soon as the state ends.

`data/rules.seed.json` holds 15 example rules, one per scenario:

- `lead_1` watches every queue: SLA breached, near SLA (80 to 100%), more than 20 waiting.
- Each lead watches their own team (`data/directory.json`): out of adherence for 10 minutes, on a call for 45 minutes.
- Each agent watches themself: out of adherence for 10 minutes.

The replay prints 33 notifications, then the incidents still live when the feed ends.

Not built yet: the surface for creating rules (API, form, assistant).
