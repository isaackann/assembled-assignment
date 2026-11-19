// Shared by the tests only. Tests that are about dirt in the sample feed read the
// real line from data/events.jsonl by its line number, so they check what the feed
// actually contains rather than a retyped copy.

import { readFileSync } from "node:fs";

import type { AgentState, QueueState } from "../src/shared/catalog.ts";
import type { Rule } from "../src/shared/rule.ts";

const FEED_URL = new URL("../data/events.jsonl", import.meta.url);

/** Epoch milliseconds for a time of day on the sample feed's date: at("09:30:00"). */
export const at = (time: string): number => Date.parse(`2026-05-26T${time}Z`);

/** Every line of the sample feed. */
export function feedLines(): string[] {
  return readFileSync(FEED_URL, "utf8").split("\n");
}

/** One line of the sample feed, by its 1-based line number. */
export function feedLine(lineNumber: number): string {
  const line = feedLines()[lineNumber - 1];
  if (!line) throw new Error(`The sample feed has no line ${lineNumber}`);
  return line;
}

/** A queue snapshot line. Billing, healthy, at 09:00 unless overridden. */
export function snapshotLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: "evt_test",
    ts: "2026-05-26T09:00:00Z",
    type: "queue_snapshot",
    queue_id: "billing",
    tickets_waiting: 5,
    longest_wait_sec: 60,
    sla_target_sec: 120,
    agents_available: 2,
    agents_on_call: 2,
    volume_last_15m: 10,
    volume_forecast_next_15m: 12,
    ...overrides,
  });
}

/** A queue's state. Billing at 130s against a 120s target (breached) unless overridden. */
export function queueState(overrides: Partial<QueueState> = {}): QueueState {
  return {
    queue_id: "billing",
    tickets_waiting: 18,
    longest_wait_sec: 130,
    sla_target_sec: 120,
    agents_available: 0,
    agents_on_call: 4,
    volume_last_15m: 28,
    volume_forecast_next_15m: 38,
    last_event_ts: at("09:30:00"),
    ...overrides,
  };
}

/** The seeded rule: lead_1 is told when billing breaches its SLA. */
export function breachRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rule_billing_sla_breached",
    owner_id: "lead_1",
    subject: { kind: "queue", resource_ids: ["billing"] },
    conditions: [{ field: "sla_pct", op: ">", value: 100 }],
    for_seconds: 0,
    ...overrides,
  };
}

/** An agent's state. a_19 on break since 09:35, out of adherence since 09:35, unless overridden. */
export function agentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agent_id: "a_19",
    state: "on_break",
    state_since: at("09:35:00"),
    violation_since: at("09:35:00"),
    last_event_ts: at("09:36:00"),
    ...overrides,
  };
}

/** lead_1 is told when one of their agents has been out of adherence for 10 minutes. */
export function adherenceRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "rule_lead_1_team_adherence",
    owner_id: "lead_1",
    subject: { kind: "team", resource_ids: ["team_1"] },
    conditions: [{ field: "in_violation", op: "=", value: true }],
    for_seconds: 600,
    ...overrides,
  };
}
