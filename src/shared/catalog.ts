// The field catalog: the list of things a rule is allowed to test.
// This is the one place to extend. A field added here can be used in a rule
// without touching the engine.

/** What is currently known about one queue: its latest snapshot. */
export interface QueueState {
  queue_id: string;
  tickets_waiting: number;
  longest_wait_sec: number;
  sla_target_sec: number;
  agents_available: number;
  agents_on_call: number;
  volume_last_15m: number;
  volume_forecast_next_15m: number | null;
  last_event_ts: number;
}

/** A queue field a rule can test. `read` returns null when the value is unknown. */
export interface QueueField {
  name: string;
  read(queue: QueueState): number | null;
}

/** Longest wait as a percentage of the SLA target, so rules never need arithmetic. */
function slaPct(queue: QueueState): number | null {
  if (queue.sla_target_sec <= 0) return null;
  return (queue.longest_wait_sec / queue.sla_target_sec) * 100;
}

/** Every queue field a rule can test. */
export const QUEUE_FIELDS: QueueField[] = [
  { name: "sla_pct", read: slaPct },
  { name: "tickets_waiting", read: (queue) => queue.tickets_waiting },
  { name: "longest_wait_sec", read: (queue) => queue.longest_wait_sec },
];

/** Reads one catalog field from a queue. Throws if the catalog has no such field. */
export function readQueueField(name: string, queue: QueueState): number | null {
  const field = QUEUE_FIELDS.find((candidate) => candidate.name === name);
  if (!field) throw new Error(`Unknown queue field "${name}"`);
  return field.read(queue);
}
