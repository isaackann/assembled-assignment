// Turns one raw feed line into a typed event, or says why it cannot.
// Everything after this step can trust the shape of an event. Known dirt in the
// feed is fixed here (a null `queue_ids` becomes an empty list); anything else
// that does not fit is rejected with a reason rather than guessed at.
// Times become epoch milliseconds so the rest of the engine compares plain numbers.

/** Queue state reported on a cadence. */
export interface QueueSnapshot {
  event_id: string;
  ts: number;
  type: "queue_snapshot";
  queue_id: string;
  tickets_waiting: number;
  longest_wait_sec: number;
  sla_target_sec: number;
  agents_available: number;
  agents_on_call: number;
  volume_last_15m: number;
  volume_forecast_next_15m: number | null;
}

/** An agent moving from one state to another. The first one for an agent has no previous state. */
export interface AgentStateChange {
  event_id: string;
  ts: number;
  type: "agent_state_change";
  agent_id: string;
  queue_ids: string[];
  previous_state: string | null;
  previous_state_duration_sec: number | null;
  new_state: string;
}

/** A scheduled-versus-actual comparison for one agent. */
export interface AdherenceCheck {
  event_id: string;
  ts: number;
  type: "adherence_check";
  agent_id: string;
  queue_ids: string[];
  scheduled_state: string;
  actual_state: string;
  in_violation: boolean;
  violation_started_at: number | null;
}

/** Any event the feed can carry. */
export type FeedEvent = QueueSnapshot | AgentStateChange | AdherenceCheck;

/** The result of normalising one line. */
export type Normalized = { ok: true; event: FeedEvent } | { ok: false; reason: string };

type Raw = Record<string, unknown>;

/** Thrown by the readers below; `normalize` turns it into a reject reason. */
class Reject extends Error {}

// A timestamp with no zone would be read as local time, so the zone is required.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Parses and checks one feed line. Never throws for bad input. */
export function normalize(line: string): Normalized {
  try {
    return { ok: true, event: toEvent(parseObject(line)) };
  } catch (err) {
    if (err instanceof Reject) return { ok: false, reason: err.message };
    throw err;
  }
}

/** Formats epoch milliseconds the way the feed writes times: 2026-05-26T09:30:00Z. */
export function formatTime(ts: number): string {
  return new Date(ts).toISOString().replace(".000Z", "Z");
}

function parseObject(line: string): Raw {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Reject("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Reject("not a JSON object");
  }
  return parsed as Raw;
}

function toEvent(raw: Raw): FeedEvent {
  const event_id = text(raw, "event_id");
  const ts = time(raw, "ts");
  const type = text(raw, "type");

  switch (type) {
    case "queue_snapshot":
      return {
        event_id,
        ts,
        type,
        queue_id: text(raw, "queue_id"),
        tickets_waiting: count(raw, "tickets_waiting"),
        longest_wait_sec: count(raw, "longest_wait_sec"),
        sla_target_sec: count(raw, "sla_target_sec"),
        agents_available: count(raw, "agents_available"),
        agents_on_call: count(raw, "agents_on_call"),
        volume_last_15m: count(raw, "volume_last_15m"),
        volume_forecast_next_15m: orNull(raw, "volume_forecast_next_15m", count),
      };
    case "agent_state_change":
      return {
        event_id,
        ts,
        type,
        agent_id: text(raw, "agent_id"),
        queue_ids: queueIds(raw),
        previous_state: orNull(raw, "previous_state", text),
        previous_state_duration_sec: orNull(raw, "previous_state_duration_sec", count),
        new_state: text(raw, "new_state"),
      };
    case "adherence_check":
      return {
        event_id,
        ts,
        type,
        agent_id: text(raw, "agent_id"),
        queue_ids: queueIds(raw),
        scheduled_state: text(raw, "scheduled_state"),
        actual_state: text(raw, "actual_state"),
        in_violation: flag(raw, "in_violation"),
        violation_started_at: orNull(raw, "violation_started_at", time),
      };
    default:
      throw new Reject(`unknown type "${type}"`);
  }
}

// Agent states are read as plain text: the assignment's list of states ends in "etc.",
// so a state we have not seen before is not an error.
function text(raw: Raw, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || value === "") throw new Reject(`${key} must be a non-empty string`);
  return value;
}

function count(raw: Raw, key: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Reject(`${key} must be a number, zero or more`);
  }
  return value;
}

function flag(raw: Raw, key: string): boolean {
  const value = raw[key];
  if (typeof value !== "boolean") throw new Reject(`${key} must be true or false`);
  return value;
}

function time(raw: Raw, key: string): number {
  const value = raw[key];
  if (typeof value !== "string" || !ISO_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Reject(`${key} must be an ISO time with a zone`);
  }
  return Date.parse(value);
}

/** Reads a field that the feed is allowed to send as null. A missing key is still a reject. */
function orNull<T>(raw: Raw, key: string, read: (raw: Raw, key: string) => T): T | null {
  return raw[key] === null ? null : read(raw, key);
}

/** The feed sends `queue_ids: null` on some agent events; treat it as no queues. */
function queueIds(raw: Raw): string[] {
  const value = raw.queue_ids;
  if (value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Reject("queue_ids must be a list of strings or null");
  }
  return value;
}
