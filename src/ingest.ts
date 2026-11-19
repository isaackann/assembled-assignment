// The two things that can change incidents, and the one place the pure engine and
// the store meet:
//   handleEvent  one event arrived: record it, apply it, check the rules
//   tick         time passed: fire the incident timers that came due
// Neither reads the system clock; the caller passes `now`. In production the events
// webhook calls handleEvent and a scheduled job calls tick (src/functions/). The
// scripts in scripts/ call them with the sample feed's own times.

import { evaluateRule, ruleCovers } from "./engine/evaluate.ts";
import { type Incident, type IncidentChange, onEvaluation, onTimer } from "./engine/incidents.ts";
import { formatTime, normalize } from "./engine/normalize.ts";
import { applyAgentEvent, applyQueueSnapshot } from "./engine/state.ts";
import { type AgentState, type SubjectState, findField, subjectIdOf } from "./shared/catalog.ts";
import { type Rule, type StateKind, stateKindOf } from "./shared/rule.ts";
import {
  type Db,
  type Notification,
  getAgentState,
  getLiveIncident,
  getQueueState,
  getRule,
  insertEvent,
  insertIncident,
  insertNotification,
  listRules,
  listTeamAgentIds,
  nextDueIncident,
  saveAgentState,
  saveQueueState,
  transaction,
  updateIncident,
} from "./store/store.ts";

/** What became of a line. Only `applied` can change state or open an incident. */
export type Outcome = "applied" | "late" | "duplicate" | "rejected";

/** The result of handling one line. */
export interface IngestResult {
  outcome: Outcome;
  /** Why the line was not applied; null when it was. */
  reason: string | null;
  /** Evaluation time used for this line: the later of `now` and its timestamp. */
  now: number;
  notifications: Notification[];
}

/**
 * Handles one event (one line of the feed). `now` is evaluation time, owned by the
 * caller: this code never reads the system clock, so a replay gives the same result
 * every time.
 */
export function handleEvent(db: Db, line: string, now: number): IngestResult {
  const parsed = normalize(line);
  if (!parsed.ok)
    return {
      outcome: "rejected",
      reason: parsed.reason,
      now,
      notifications: [],
    };
  const event = parsed.event;

  // Evaluation time only moves forward. An event with an older timestamp does not rewind it.
  const clock = Math.max(now, event.ts);

  const result = (outcome: Outcome, reason: string | null, notifications: Notification[]) => {
    return { outcome, reason, now: clock, notifications };
  };

  // Recording, applying and the incident writes are one transaction.
  return transaction(db, () => {
    const isQueue = event.type === "queue_snapshot";
    const subjectId = isQueue ? event.queue_id : event.agent_id;
    const previous = isQueue ? getQueueState(db, subjectId) : getAgentState(db, subjectId);
    const newest = previous?.last_event_ts ?? null;
    // Strictly older: two events for one subject can share a timestamp, and both count.
    const late = newest !== null && event.ts < newest;

    // The duplicate check comes from the insert itself, so it wins over the late check.
    if (!insertEvent(db, event, subjectId, late ? "late" : "applied")) {
      return result("duplicate", `duplicate of ${event.event_id}`, []);
    }
    if (late) {
      return result("late", `late, ${subjectId} already has data from ${formatTime(newest)}`, []);
    }

    if (event.type === "queue_snapshot") {
      const queue = applyQueueSnapshot(event);
      saveQueueState(db, queue);
      return result("applied", null, checkRules(db, "queue", queue, event.ts, clock, previous));
    }
    if (event.type === "adherence_check" || event.type === "agent_state_change") {
      const agent = applyAgentEvent(previous as AgentState | null, event);
      saveAgentState(db, agent);
      return result("applied", null, checkRules(db, "agent", agent, event.ts, clock, previous));
    }

    return result("rejected", `Non-registered event.type`, []);
  });
}

/**
 * Fires every live incident's timer that is due by `now`, in its own transaction.
 * Called by the scheduled job. handleEvent does not tick: it only settles an overdue
 * deadline on an incident it is about to change (see checkRules).
 */
export function tick(db: Db, now: number): Notification[] {
  return transaction(db, () => fireDueTimers(db, now));
}

/**
 * Fires every live incident's timer that is due by `clock`, earliest first. Asks
 * again after each one, because a follow-up schedules the next and a long gap
 * between events can make that one due too.
 */
function fireDueTimers(db: Db, clock: number): Notification[] {
  const written: Notification[] = [];
  for (let due = nextDueIncident(db, clock); due; due = nextDueIncident(db, clock)) {
    const rule = getRule(db, due.rule_id);
    if (!rule) throw new Error(`Incident ${due.id}: its rule is missing`);
    const state =
      stateKindOf(rule.subject) === "queue"
        ? getQueueState(db, due.subject_id)
        : getAgentState(db, due.subject_id);
    if (!state) throw new Error(`Incident ${due.id}: its subject has no state`);

    written.push(...fireTimer(db, rule, due, state));
  }
  return written;
}

/** Fires one incident's timer, stamped with its due time, and writes the change. */
function fireTimer(db: Db, rule: Rule, incident: Incident, state: SubjectState): Notification[] {
  const at = incident.next_due_at!;
  return writeChange(db, incident.id, onTimer({ rule, incident, state, at }));
}

/**
 * Checks every rule that covers this subject against its new state. `previous` is
 * the subject's state before this event, or null if it had none.
 */
function checkRules(
  db: Db,
  kind: StateKind,
  state: SubjectState,
  eventTs: number,
  now: number,
  previous: SubjectState | null,
): Notification[] {
  const subjectId = subjectIdOf(state);
  const written: Notification[] = [];

  for (const rule of listRules(db)) {
    if (stateKindOf(rule.subject) !== kind) continue;
    // Read when the event arrives, so a team rule follows the roster as it changes.
    const team =
      rule.subject.kind === "team" ? listTeamAgentIds(db, rule.subject.resource_ids) : [];
    if (!ruleCovers(rule, subjectId, team)) continue;

    let live = getLiveIncident(db, rule.id, subjectId);
    // The event must not overtake a deadline on this incident that the scheduled tick
    // has not reached yet: an opening after a "for", a follow-up, a settled close.
    // Settle it first, against the state before the event, as the tick would have.
    // (A live incident means the subject already had state, so `previous` is set.)
    while (live?.next_due_at != null && live.next_due_at <= now) {
      written.push(...fireTimer(db, rule, live, previous!));
      live = getLiveIncident(db, rule.id, subjectId);
    }
    const result = evaluateRule(rule, state);
    // A new call ends the old episode even when the predicate still holds.
    // Compare individual fields: an unknown conjunction start must not hide a restart.
    const restarted =
      result.holds &&
      previous !== null &&
      rule.conditions.some((condition) => {
        const field = findField(kind, condition.field);
        const before = field.since?.(previous) ?? null;
        const after = field.since?.(state) ?? null;
        return before !== null && after !== null && after > before;
      });
    if (live && restarted) {
      const ended = onEvaluation({
        rule,
        state: previous!,
        result: { holds: false, since: null },
        live,
        eventTs,
        now,
      });
      if (ended) written.push(...writeChange(db, live.id, ended));
      live = null;
    }
    const change = onEvaluation({
      rule,
      state,
      result,
      live,
      eventTs,
      now,
    });
    if (change) written.push(...writeChange(db, live?.id ?? null, change));
  }
  return written;
}

/** Writes an incident change and its notifications. `id` is null for a new incident. */
function writeChange(db: Db, id: number | null, change: IncidentChange): Notification[] {
  const incidentId = id ?? insertIncident(db, change.next);
  if (id !== null) updateIncident(db, id, change.next);
  return change.notifications.map((notification) =>
    insertNotification(db, incidentId, notification),
  );
}
