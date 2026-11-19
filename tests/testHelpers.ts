// Shared by the tests only. Tests that are about dirt in the sample feed read the
// real line from data/events.jsonl by its line number, so they check what the feed
// actually contains rather than a retyped copy.

import { readFileSync } from "node:fs";

import { formatTime } from "../src/engine/normalize.ts";
import type { AgentState, QueueState } from "../src/shared/catalog.ts";
import type { Rule } from "../src/shared/rule.ts";
import type { Db } from "../src/store/store.ts";

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

/**
 * The 33 notifications the shipped rules fire on the sample feed, worked out by
 * hand from the feed before the engine was written: time, kind, recipient, subject,
 * rule. The acceptance table for the replay and the simulation.
 */
export const SAMPLE_EXPECTED = [
  ["09:30:00", "opened", "lead_1", "billing", "rule_sla_breached"],
  ["09:36:00", "opened", "lead_1", "billing", "rule_over_20_waiting"],
  ["09:45:00", "follow_up", "lead_1", "billing", "rule_sla_breached"],
  ["09:45:00", "closed", "lead_1", "billing", "rule_over_20_waiting"],
  ["09:45:00", "opened", "lead_1", "tier_2", "rule_sla_near"],
  ["09:45:00", "opened", "lead_1", "a_19", "rule_lead_1_team_adherence"],
  ["09:45:00", "opened", "a_19", "a_19", "rule_a_19_adherence"],
  ["09:55:00", "opened", "lead_2", "a_11", "rule_lead_2_team_long_call"],
  ["10:00:00", "follow_up", "lead_1", "billing", "rule_sla_breached"],
  ["10:00:00", "follow_up", "lead_1", "tier_2", "rule_sla_near"],
  ["10:00:00", "follow_up", "lead_1", "a_19", "rule_lead_1_team_adherence"],
  ["10:00:00", "follow_up", "a_19", "a_19", "rule_a_19_adherence"],
  ["10:00:00", "opened", "lead_1", "tier_2", "rule_sla_breached"],
  ["10:05:00", "closed", "lead_1", "tier_2", "rule_sla_near"],
  ["10:10:00", "opened", "lead_2", "a_88", "rule_lead_2_team_adherence"],
  ["10:10:00", "opened", "a_88", "a_88", "rule_a_88_adherence"],
  ["10:10:00", "opened", "lead_1", "a_07", "rule_lead_1_team_long_call"],
  ["10:10:00", "follow_up", "lead_2", "a_11", "rule_lead_2_team_long_call"],
  ["10:10:30", "closed", "lead_1", "a_19", "rule_lead_1_team_adherence"],
  ["10:10:30", "closed", "a_19", "a_19", "rule_a_19_adherence"],
  ["10:15:00", "follow_up", "lead_1", "billing", "rule_sla_breached"],
  ["10:15:00", "follow_up", "lead_1", "tier_2", "rule_sla_breached"],
  ["10:15:00", "opened", "lead_1", "a_31", "rule_lead_1_team_long_call"],
  ["10:16:00", "opened", "lead_1", "billing", "rule_sla_near"],
  ["10:20:00", "closed", "lead_1", "billing", "rule_sla_breached"],
  ["10:20:00", "closed", "lead_1", "tier_2", "rule_sla_breached"],
  ["10:20:00", "closed", "lead_2", "a_11", "rule_lead_2_team_long_call"],
  ["10:25:00", "closed", "lead_1", "a_31", "rule_lead_1_team_long_call"],
  ["10:25:00", "follow_up", "lead_2", "a_88", "rule_lead_2_team_adherence"],
  ["10:25:00", "follow_up", "a_88", "a_88", "rule_a_88_adherence"],
  ["10:25:00", "follow_up", "lead_1", "a_07", "rule_lead_1_team_long_call"],
  ["10:25:30", "opened", "lead_2", "a_23", "rule_lead_2_team_adherence"],
  ["10:25:30", "opened", "a_23", "a_23", "rule_a_23_adherence"],
];

/** Every stored notification as [time of day, kind, recipient, subject, rule]. */
export function notificationRows(db: Db): string[][] {
  return db
    .prepare(
      `select n.at, n.kind, n.recipient_id, i.subject_id, i.rule_id
       from notifications n join incidents i on n.incident_id = i.id`,
    )
    .all()
    .map((row) => [
      formatTime(row.at as number).slice(11, 19),
      row.kind as string,
      row.recipient_id as string,
      row.subject_id as string,
      row.rule_id as string,
    ]);
}

/** Rows in a comparable order. Within one second the order follows incident ids, which the tables do not try to predict. */
export const sortedRows = (list: unknown[][]): string[] => list.map((row) => row.join(" ")).sort();
