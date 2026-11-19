// The field catalog: the list of things a rule is allowed to test.
// This is the one place to extend. A field added here can be used in a rule
// without touching the engine.

import type { Condition, StateKind } from "./rule.ts";

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

/** What is currently known about one agent, built up from state changes and adherence checks. */
export interface AgentState {
  agent_id: string;
  state: string;
  /** When the agent entered `state`, by the feed's own times. */
  state_since: number;
  /** When the current violation started; null when the agent is in adherence. */
  violation_since: number | null;
  last_event_ts: number;
}

/** The current state of any subject. */
export type SubjectState = QueueState | AgentState;

/** A field's value; null when it is unknown. */
export type FieldValue = number | string | boolean | null;

export type FieldType = "number" | "string" | "boolean";

/** The operators a rule may use on each type of field. */
export const OPERATORS: Record<FieldType, Condition["op"][]> = {
  number: [">", ">=", "<", "<="],
  string: ["=", "in"],
  boolean: ["="],
};

/** A field a rule can test. */
export interface Field {
  name: string;
  /** How the field reads in a message: "SLA used 108%". */
  label: string;
  /** Decides which operators apply (OPERATORS), and whether an incident settles before it closes. */
  type: FieldType;
  /** Printed after a number: "%" or "s". */
  unit?: string;
  /** For a text field, every value a rule may name. A value outside it would never match. */
  values?: string[];
  read(state: SubjectState): FieldValue;
  /** When the current value started, if the feed says. Used for "for 10 minutes". */
  since?(state: SubjectState): number | null;
}

/** Longest wait as a percentage of the SLA target, so rules never need arithmetic. */
function slaPct(queue: QueueState): number | null {
  if (queue.sla_target_sec <= 0) return null;
  return (queue.longest_wait_sec / queue.sla_target_sec) * 100;
}

/** Every queue field a rule can test. */
const QUEUE_FIELDS: Field[] = [
  {
    name: "sla_pct",
    label: "SLA used",
    type: "number",
    unit: "%",
    read: (s) => slaPct(asQueue(s)),
  },
  {
    name: "tickets_waiting",
    label: "tickets waiting",
    type: "number",
    read: (s) => asQueue(s).tickets_waiting,
  },
  {
    name: "longest_wait_sec",
    label: "longest wait",
    type: "number",
    unit: "s",
    read: (s) => asQueue(s).longest_wait_sec,
  },
];

/** Every agent field a rule can test. */
const AGENT_FIELDS: Field[] = [
  {
    name: "state",
    label: "state",
    type: "string",
    values: ["available", "on_call", "on_break", "in_meeting", "offline"],
    read: (s) => asAgent(s).state,
    since: (s) => asAgent(s).state_since,
  },
  {
    name: "in_violation",
    label: "out of adherence",
    type: "boolean",
    // An agent out of adherence always has a start (state.ts), so this is the one record of it.
    read: (s) => asAgent(s).violation_since !== null,
    since: (s) => asAgent(s).violation_since,
  },
];

const CATALOG: Record<StateKind, Field[]> = { queue: QUEUE_FIELDS, agent: AGENT_FIELDS };

/** The catalog entry for a field, or null if the catalog has no such field. */
export function lookupField(kind: StateKind, name: string): Field | null {
  return CATALOG[kind].find((candidate) => candidate.name === name) ?? null;
}

/** The catalog entry for a field. Throws if the catalog has no such field. */
export function findField(kind: StateKind, name: string): Field {
  const field = lookupField(kind, name);
  if (!field) throw new Error(`Unknown ${kind} field "${name}"`);
  return field;
}

/** Every field of a kind, in catalog order. */
export function listFields(kind: StateKind): Field[] {
  return CATALOG[kind];
}

/** The queue or agent id of a subject's state. */
export function subjectIdOf(state: SubjectState): string {
  return "queue_id" in state ? state.queue_id : state.agent_id;
}

function asQueue(state: SubjectState): QueueState {
  if (!("queue_id" in state)) throw new Error(`Expected a queue, got agent ${state.agent_id}`);
  return state;
}

function asAgent(state: SubjectState): AgentState {
  if (!("agent_id" in state)) throw new Error(`Expected an agent, got queue ${state.queue_id}`);
  return state;
}
