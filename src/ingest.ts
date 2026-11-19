// What happens to one line of the feed, in order: normalise it, advance the clock,
// record it, apply it, check the rules, and hand back any notifications.
// This is the one place the pure engine and the store meet. The replay calls it
// for each line of a file; a live service would call it for each event received.

import { conditionsHold, ruleCoversQueue } from "./engine/evaluate.ts";
import { stepIncident } from "./engine/incidents.ts";
import { type FeedEvent, type QueueSnapshot, formatTime, normalize } from "./engine/normalize.ts";
import { applyQueueSnapshot } from "./engine/state.ts";
import {
  type Db,
  type Notification,
  getAgentLastEventTs,
  getLiveIncident,
  getQueueState,
  insertEvent,
  insertIncident,
  insertNotification,
  listRules,
  saveAgentLastEventTs,
  saveQueueState,
  transaction,
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
  if (!parsed.ok) return { outcome: "rejected", reason: parsed.reason, now, notifications: [] };
  const event = parsed.event;

  // Evaluation time only moves forward. An event with an older timestamp does not rewind it.
  const clock = Math.max(now, event.ts);
  const skip = (outcome: Outcome, reason: string): IngestResult => {
    return { outcome, reason, now: clock, notifications: [] };
  };

  // Recording, applying and the incident writes are one transaction.
  return transaction(db, () => {
    const subjectId = event.type === "queue_snapshot" ? event.queue_id : event.agent_id;
    const newest = lastEventTs(db, event);
    // Strictly older: two events for one subject can share a timestamp, and both count.
    const late = newest !== null && event.ts < newest;

    // The duplicate check comes from the insert itself, so it wins over the late check.
    if (!insertEvent(db, event, subjectId, late ? "late" : "applied")) {
      return skip("duplicate", `duplicate of ${event.event_id}`);
    }
    if (late) {
      return skip("late", `late, ${subjectId} already has data from ${formatTime(newest)}`);
    }

    if (event.type !== "queue_snapshot") {
      saveAgentLastEventTs(db, event.agent_id, event.ts);
      return { outcome: "applied", reason: null, now: clock, notifications: [] };
    }
    const notifications = applySnapshot(db, event, clock);
    return { outcome: "applied", reason: null, now: clock, notifications };
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
      report.skipped.push({ line: index + 1, outcome: result.outcome, reason: result.reason });
    }
    report.notifications.push(...result.notifications);
    deliver(result.notifications);
  });

  return report;
}

function lastEventTs(db: Db, event: FeedEvent): number | null {
  if (event.type === "queue_snapshot") {
    return getQueueState(db, event.queue_id)?.last_event_ts ?? null;
  }
  return getAgentLastEventTs(db, event.agent_id);
}

/** Saves the queue's new state, then checks every rule that covers the queue. */
function applySnapshot(db: Db, snapshot: QueueSnapshot, now: number): Notification[] {
  const queue = applyQueueSnapshot(snapshot);
  saveQueueState(db, queue);

  const written: Notification[] = [];
  for (const rule of listRules(db)) {
    if (!ruleCoversQueue(rule, queue.queue_id)) continue;

    const change = stepIncident({
      rule,
      queue,
      holds: conditionsHold(rule, queue),
      live: getLiveIncident(db, rule.id, queue.queue_id),
      startedAt: snapshot.ts,
      now,
    });
    if (!change) continue;

    const incidentId = insertIncident(db, change.incident);
    for (const notification of change.notifications) {
      written.push(insertNotification(db, incidentId, notification));
    }
  }
  return written;
}
