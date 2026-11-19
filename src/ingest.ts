// What happens to one line of the feed, in order: normalise it, advance the clock
// and fire any timers that came due, record it, apply it, check the rules, and
// hand back any notifications.
// This is the one place the pure engine and the store meet. The replay calls it
// for each line of a file; a live service would call it for each event received.

import { evaluateRule, ruleCovers } from "./engine/evaluate.ts";
import { type IncidentChange, onEvaluation, onTimer } from "./engine/incidents.ts";
import { formatTime, normalize } from "./engine/normalize.ts";
import { applyAgentEvent, applyQueueSnapshot } from "./engine/state.ts";
import { type SubjectState, findField, subjectIdOf } from "./shared/catalog.ts";
import { type StateKind, stateKindOf } from "./shared/rule.ts";
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
  /** Evaluation time after this line. Pass it back in with the next line. */
  now: number;
  notifications: Notification[];
}

/** A line that was not applied, for the replay summary. */
export interface SkippedLine {
  line: number;
  outcome: Outcome;
  reason: string;
}

/** What a replay did. */
export interface ReplayReport {
  lines: number;
  counts: Record<Outcome, number>;
  skipped: SkippedLine[];
  notifications: Notification[];
}

/**
 * Handles one line. `now` is evaluation time, owned by the caller: this code never
 * reads the system clock, so a replay gives the same result every time.
 */
export function ingestLine(db: Db, line: string, now: number): IngestResult {
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

  // Time has passed: whatever came due by now fires first, stamped with its due
  // time, before this event is applied. A duplicate or late line still moves time.
  const fired = transaction(db, () => fireDueTimers(db, clock));
  const result = (outcome: Outcome, reason: string | null, notifications: Notification[]) => {
    return {
      outcome,
      reason,
      now: clock,
      notifications: [...fired, ...notifications],
    };
  };

  // Recording, applying and the incident writes are one transaction.
  return transaction(db, () => {
    const isQueue = event.type === "queue_snapshot";
    const subjectId = isQueue ? event.queue_id : event.agent_id;
    const prevAgent = isQueue ? null : getAgentState(db, subjectId);
    const newest = isQueue
      ? (getQueueState(db, subjectId)?.last_event_ts ?? null)
      : (prevAgent?.last_event_ts ?? null);
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
      return result("applied", null, checkRules(db, "queue", queue, event.ts, clock));
    }
    if (event.type === "adherence_check" || event.type === "agent_state_change") {
      const agent = applyAgentEvent(prevAgent, event);
      saveAgentState(db, agent);
      return result("applied", null, checkRules(db, "agent", agent, event.ts, clock, prevAgent));
    }

    return result("rejected", `Non-registered event.type`, []);
  });
}

/**
 * Replays a feed line by line, starting the clock at zero. `deliver` is called with
 * each line's notifications as they are written.
 */
export function replayFeed(
  db: Db,
  lines: string[],
  deliver: (notifications: Notification[]) => void,
): ReplayReport {
  const report: ReplayReport = {
    lines: 0,
    counts: { applied: 0, late: 0, duplicate: 0, rejected: 0 },
    skipped: [],
    notifications: [],
  };
  let now = 0;

  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    const result = ingestLine(db, line, now);
    now = result.now;

    report.lines += 1;
    report.counts[result.outcome] += 1;
    if (result.reason !== null) {
      report.skipped.push({
        line: index + 1,
        outcome: result.outcome,
        reason: result.reason,
      });
    }
    report.notifications.push(...result.notifications);
    deliver(result.notifications);
  });

  return report;
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

    written.push(
      ...writeChange(db, due.id, onTimer({ rule, incident: due, state, at: due.next_due_at! })),
    );
  }
  return written;
}

/** Checks every rule that covers this subject against its new state. */
function checkRules(
  db: Db,
  kind: StateKind,
  state: SubjectState,
  eventTs: number,
  now: number,
  previous: SubjectState | null = null,
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
