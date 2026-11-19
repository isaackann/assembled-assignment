// The shape of a notification rule. A rule is data, not code: it names what it
// watches, the conditions that must all hold, and how long they must hold before
// anyone is told. Its owner is the person who created it and the person it notifies.
// The engine and (later) the API, the form and the assistant all use this one type.

/** Comparisons on a number field, `=` on any field, and `in` on a text field. */
export type Operator = ">" | ">=" | "<" | "<=" | "=" | "in";

/** What a condition compares against: a number, a text value, yes/no, or a list of text values for `in`. */
export type ConditionValue = number | string | boolean | string[];

/** One test of a catalog field against a fixed value. */
export interface Condition {
  field: string;
  op: Operator;
  value: ConditionValue;
}

/**
 * What a rule watches, by id: named queues, named agents, or every agent on the
 * named teams. "Me" is an agent rule naming its owner; "my team" is a team rule
 * naming the owner's team. An empty list watches nothing.
 */
export interface Subject {
  kind: "queue" | "agent" | "team";
  resource_ids: string[];
}

/** Whose state a rule's conditions read: a queue's, or an agent's (team rules test agents). */
export type StateKind = "queue" | "agent";

/** The state a rule's conditions are tested against. */
export function stateKindOf(subject: Subject): StateKind {
  return subject.kind === "queue" ? "queue" : "agent";
}

/** A notification rule. */
export interface Rule {
  id: string;
  owner_id: string;
  subject: Subject;
  conditions: Condition[];
  /** How long the conditions must hold before the rule fires. 0 fires as soon as they hold. */
  for_seconds: number;
}
