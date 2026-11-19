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

A walking skeleton: every line of the sample feed goes through the full path (parse and check, drop duplicates, set late events aside, update queue state, check the rules, write the incident and its notification in one transaction, print it), with the thinnest possible logic at each step.

One rule is seeded in `data/rules.seed.json`: tell `lead_1` when the billing queue has breached its SLA. The replay prints one notification for it, at 09:30, and stays quiet for the five breached snapshots that follow.

Not built yet: duration rules ("for 10 minutes"), follow-ups and closing messages, agent rules, and the surface for creating rules.
