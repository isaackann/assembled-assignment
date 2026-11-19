// The shape of a notification rule. A rule is data, not code: it names what it
// watches, the conditions that must all hold, and how long they must hold before
// anyone is told. Its owner is the person who created it and the person it notifies.
// The engine and (later) the API, the form and the assistant all use this one type.

/**
 * One test of a catalog field against a fixed value. The operator decides the
 * value's type, so an operator and a value that disagree cannot be written:
 * comparisons take a number, `in` takes a list of text values, `=` takes one value.
 */
export type Condition =
  | { field: string; op: ">" | ">=" | "<" | "<="; value: number }
  | { field: string; op: "in"; value: string[] }
  | { field: string; op: "="; value: string | number | boolean };

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
