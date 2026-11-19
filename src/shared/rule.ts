// The shape of a notification rule. A rule is data, not code: it names a subject,
// which of those subjects it covers, and the conditions that must all hold.
// The engine and (later) the API, the form and the assistant all use this one type.

/** Comparisons allowed on a number field. */
export type Operator = ">" | ">=" | "<" | "<=";

/** One test of a catalog field against a fixed value. */
export interface Condition {
  field: string;
  op: Operator;
  value: number;
}

/** Which subjects a rule covers. Only named queues so far. */
export interface Scope {
  kind: "queues";
  queue_ids: string[];
}

/** A notification rule. Its owner is the person it notifies. */
export interface Rule {
  id: string;
  owner_id: string;
  subject: "queue";
  scope: Scope;
  conditions: Condition[];
}
