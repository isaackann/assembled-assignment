// An incident is one rule being true for one subject. This file decides what a
// rule result means for the incident: so far, only "open it and tell the owner".
// It notifies when a rule BECOMES true, not every time it is seen true, which is
// what keeps six breached snapshots from becoming six messages.
// Follow-ups, settling and closing are not built yet, so an incident never ends.

import { type QueueState, readQueueField } from "../shared/catalog.ts";
import type { Rule } from "../shared/rule.ts";

/** An incident before the store has given it an id. */
export interface NewIncident {
  rule_id: string;
  subject_id: string;
  status: "open";
  started_at: number;
  opened_at: number;
}

/** A stored incident. */
export interface Incident extends NewIncident {
  id: number;
}

/** A notification before the store has attached it to an incident. */
export interface NewNotification {
  recipient_id: string;
  kind: "opened";
  seq: number;
  at: number;
  message: string;
  detail: Record<string, number | null>;
}

/** What to write after checking a rule: a new incident and its notifications. */
export interface IncidentChange {
  incident: NewIncident;
  notifications: NewNotification[];
}

/** What the caller knows when it checks one rule against one queue. */
export interface IncidentInput {
  rule: Rule;
  queue: QueueState;
  holds: boolean;
  live: Incident | null;
  /** When the condition was first seen true: the event's own time. */
  startedAt: number;
  /** Evaluation time. Notifications are stamped with this, never backdated. */
  now: number;
}

/** Returns the incident to open, or null when there is nothing to do. */
export function stepIncident(input: IncidentInput): IncidentChange | null {
  const { rule, queue, holds, live, startedAt, now } = input;
  if (!holds || live) return null;

  return {
    incident: {
      rule_id: rule.id,
      subject_id: queue.queue_id,
      status: "open",
      started_at: startedAt,
      opened_at: now,
    },
    notifications: [
      {
        recipient_id: rule.owner_id,
        kind: "opened",
        seq: 0,
        at: now,
        message: describe(rule, queue),
        detail: snapshotNumbers(queue),
      },
    ],
  };
}

/** The reason in words: each tested field's value, then what the rule asked for. */
function describe(rule: Rule, queue: QueueState): string {
  const seen = rule.conditions.map((c) => `${c.field} is ${round(readQueueField(c.field, queue))}`);
  const asked = rule.conditions.map((c) => `${c.field} ${c.op} ${c.value}`);
  return `queue ${queue.queue_id}: ${seen.join(", ")} (rule: ${asked.join(" and ")})`;
}

function round(value: number | null): string {
  return value === null ? "unknown" : String(Number(value.toFixed(1)));
}

/** The queue's numbers at the moment the rule fired, kept with the notification. */
function snapshotNumbers(queue: QueueState): Record<string, number | null> {
  const { queue_id, last_event_ts, ...numbers } = queue;
  return numbers;
}
