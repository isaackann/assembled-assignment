// An incident is one rule being true for one subject. This file decides what
// happens to it, and what its owner is told, in two situations:
//   onEvaluation: an event changed the subject and the rule was checked again
//   onTimer:      time passed and the incident's next due time came
//
//   pending ──(lasted `for`)──> open ──(no longer true)──> settling ──(5 min)──> closed
//      │                         │  ↑______(true again)______│
//      └──(stopped first)──> closed, no message      └──(state rule)──> closed
//
// The owner hears once when it opens, every 15 minutes while it stays open, and
// once when it closes. Settling absorbs a number hovering at a threshold; a rule
// that only tests states (on a call, out of adherence) closes on the event,
// because a transition is definitive.

import { type FieldValue, type SubjectState, findField, subjectIdOf } from "../shared/catalog.ts";
import { type Rule, stateKindOf } from "../shared/rule.ts";
import type { Evaluation } from "./evaluate.ts";
import { describeRule, describeSeen, describeValues, minutes, seenValues } from "./messages.ts";
import { formatTime } from "./normalize.ts";

/** How often an open incident repeats. */
export const FOLLOW_UP_MS = 15 * 60 * 1000;
/** How long a number rule must stay false before its incident closes. */
export const SETTLE_MS = 5 * 60 * 1000;

export type IncidentStatus = "pending" | "open" | "settling" | "closed";

/** An incident before the store has given it an id. */
export interface NewIncident {
  rule_id: string;
  subject_id: string;
  status: IncidentStatus;
  /** When the rule started holding, by the feed's times. */
  started_at: number;
  /** When the owner was told it opened; null while pending. */
  opened_at: number | null;
  last_notified_at: number | null;
  /** When onTimer must next run for it; null once closed. */
  next_due_at: number | null;
  follow_ups: number;
  /**
   * The tested fields' values when it opened ({ sla_pct: 108.3 }), so a follow-up
   * can say what changed. Values, not words: they are put into words per message.
   */
  opened_values: Record<string, FieldValue> | null;
  closed_at: number | null;
}

/** A stored incident. */
export interface Incident extends NewIncident {
  id: number;
}

/** A notification before the store has attached it to an incident. */
export interface NewNotification {
  recipient_id: string;
  kind: "opened" | "follow_up" | "closed";
  /** 0 for opened and closed; counts up for follow-ups. */
  seq: number;
  at: number;
  message: string;
  /** The subject's state when it was sent. */
  detail: Record<string, unknown>;
}

/** The incident's next state, and anything to tell its owner. */
export interface IncidentChange {
  next: NewIncident;
  notifications: NewNotification[];
}

/** What the caller knows after an event, for one rule and one subject. */
export interface EvaluationInput {
  rule: Rule;
  state: SubjectState;
  result: Evaluation;
  live: Incident | null;
  /** The event's own time: when the rule started holding if the feed gives no better time. */
  eventTs: number;
  /** Evaluation time. Notifications are stamped with it, never backdated. */
  now: number;
}

/** Returns what changes after an event, or null when nothing does. */
export function onEvaluation(input: EvaluationInput): IncidentChange | null {
  const { rule, state, result, live, eventTs, now } = input;

  if (!live) {
    if (!result.holds) return null;
    const startedAt = result.since ?? eventTs;
    const pending: NewIncident = {
      rule_id: rule.id,
      subject_id: subjectIdOf(state),
      status: "pending",
      started_at: startedAt,
      opened_at: null,
      last_notified_at: null,
      next_due_at: startedAt + rule.for_seconds * 1000,
      follow_ups: 0,
      opened_values: null,
      closed_at: null,
    };
    // Already long enough (no `for`, or an old start time): open now. A deadline
    // found after it passed notifies at `now`, with no invented past follow-ups.
    if (pending.next_due_at! <= now) return open(rule, pending, state, now);
    return { next: pending, notifications: [] };
  }

  switch (live.status) {
    case "pending":
      // Stopped before it lasted long enough: nobody was told, so nobody is told now.
      if (result.holds) return null;
      return {
        next: { ...live, status: "closed", next_due_at: null, closed_at: now },
        notifications: [],
      };
    case "open":
      if (result.holds) return null;
      if (settles(rule))
        return {
          next: { ...live, status: "settling", next_due_at: now + SETTLE_MS },
          notifications: [],
        };
      return close(rule, live, state, now);
    case "settling":
      // True again inside the settle window: the same incident carries on.
      if (!result.holds) return null;
      return {
        next: {
          ...live,
          status: "open",
          next_due_at: Math.max(live.last_notified_at! + FOLLOW_UP_MS, now),
        },
        notifications: [],
      };
    case "closed":
      throw new Error(`Incident ${live.id} is closed and cannot be live`);
  }
}

/** What the caller knows when an incident's due time comes. */
export interface TimerInput {
  rule: Rule;
  incident: Incident;
  state: SubjectState;
  /** The due time. What fires is stamped with it. */
  at: number;
}

/** Returns what changes when an incident's timer fires. */
export function onTimer(input: TimerInput): IncidentChange {
  const { rule, incident, state, at } = input;
  switch (incident.status) {
    case "pending":
      return open(rule, incident, state, at);
    case "open":
      return followUp(rule, incident, state, at);
    case "settling":
      return close(rule, incident, state, at);
    case "closed":
      throw new Error(`Incident ${incident.id} is closed and has no timer`);
  }
}

// Settling is for numbers hovering at a threshold. A rule only about states closes at once.
function settles(rule: Rule): boolean {
  return rule.conditions.some(
    (c) => findField(stateKindOf(rule.subject), c.field).type === "number",
  );
}

function open(rule: Rule, incident: NewIncident, state: SubjectState, at: number): IncidentChange {
  const values = seenValues(rule, state);
  const seen = describeValues(rule, values);
  const held = rule.for_seconds > 0 ? ` for ${minutes(at - incident.started_at)} min` : "";
  return {
    next: {
      ...incident,
      status: "open",
      opened_at: at,
      last_notified_at: at,
      next_due_at: at + FOLLOW_UP_MS,
      opened_values: values,
    },
    notifications: [
      notification(rule, state, "opened", 0, at, `${seen}${held} (rule: ${describeRule(rule)})`),
    ],
  };
}

function followUp(rule: Rule, incident: Incident, state: SubjectState, at: number): IncidentChange {
  const seen = describeSeen(rule, state);
  // Compared as they would be written, so a change too small to show is not reported.
  const then = describeValues(rule, incident.opened_values!);
  const was = seen === then ? "" : ` (was ${then})`;
  const seq = incident.follow_ups + 1;
  return {
    next: { ...incident, follow_ups: seq, last_notified_at: at, next_due_at: at + FOLLOW_UP_MS },
    notifications: [
      notification(
        rule,
        state,
        "follow_up",
        seq,
        at,
        `still true after ${minutes(at - incident.opened_at!)} min: ${seen}${was}`,
      ),
    ],
  };
}

// The wording is neutral: a band rule ("near SLA") also ends when things get worse.
function close(rule: Rule, incident: NewIncident, state: SubjectState, at: number): IncidentChange {
  return {
    next: { ...incident, status: "closed", next_due_at: null, closed_at: at },
    notifications: [
      notification(
        rule,
        state,
        "closed",
        0,
        at,
        `no longer true after ${minutes(at - incident.opened_at!)} min: ${describeSeen(rule, state)}`,
      ),
    ],
  };
}

function notification(
  rule: Rule,
  state: SubjectState,
  kind: NewNotification["kind"],
  seq: number,
  at: number,
  text: string,
): NewNotification {
  return {
    recipient_id: rule.owner_id,
    kind,
    seq,
    at,
    message: `${stateKindOf(rule.subject)} ${subjectIdOf(state)}: ${text}`,
    detail: detailOf(state),
  };
}

/** The subject's state, kept with the notification. Times are written the way the feed writes them. */
function detailOf(state: SubjectState): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === "queue_id" || key === "agent_id" || key === "last_event_ts") continue;
    detail[key] = key.endsWith("_since") && typeof value === "number" ? formatTime(value) : value;
  }
  return detail;
}
