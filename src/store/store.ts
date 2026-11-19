// The only file that talks to SQLite. Each function is one read or one write;
// the decisions about what to read and write live in the engine and in ingest.ts.
// Statements are prepared on each call, which is fine at this size and keeps
// every function readable on its own.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { Incident, NewIncident, NewNotification } from "../engine/incidents.ts";
import type { FeedEvent } from "../engine/normalize.ts";
import type { QueueState } from "../shared/catalog.ts";
import type { Rule } from "../shared/rule.ts";

/** An open database with the schema applied. */
export type Db = DatabaseSync;

/** A stored notification. */
export interface Notification extends NewNotification {
  id: number;
  incident_id: number;
}

type Row = Record<string, unknown>;

/** Opens a database and creates the tables. Pass ":memory:" for one that lives only in this process. */
export function openStore(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  return db;
}

/** Runs `work` in one transaction: all of its writes are kept, or none are. */
export function transaction<T>(db: Db, work: () => T): T {
  db.exec("begin");
  try {
    const result = work();
    db.exec("commit");
    return result;
  } catch (err) {
    db.exec("rollback");
    throw err;
  }
}

/** Saves rules as given. */
export function seedRules(db: Db, rules: Rule[]): void {
  const insert = db.prepare(
    "insert into rules (id, owner_id, subject, scope, conditions) values (?, ?, ?, ?, ?)",
  );
  for (const rule of rules) {
    insert.run(
      rule.id,
      rule.owner_id,
      rule.subject,
      JSON.stringify(rule.scope),
      JSON.stringify(rule.conditions),
    );
  }
}

/** Every rule. */
export function listRules(db: Db): Rule[] {
  const rows = db.prepare("select * from rules order by id").all() as Row[];
  return rows.map((row) => ({
    id: row.id as string,
    owner_id: row.owner_id as string,
    subject: row.subject as Rule["subject"],
    scope: JSON.parse(row.scope as string),
    conditions: JSON.parse(row.conditions as string),
  }));
}

/**
 * Records an accepted event. Returns false, and stores nothing, when an event
 * with this id is already recorded.
 */
export function insertEvent(
  db: Db,
  event: FeedEvent,
  subjectId: string,
  outcome: "applied" | "late",
): boolean {
  const result = db
    .prepare(
      `insert into events (event_id, ts, type, subject_id, outcome, payload)
       values (?, ?, ?, ?, ?, ?) on conflict (event_id) do nothing`,
    )
    .run(event.event_id, event.ts, event.type, subjectId, outcome, JSON.stringify(event));
  return result.changes === 1;
}

/** The queue's current state, or null if no snapshot has been applied. */
export function getQueueState(db: Db, queueId: string): QueueState | null {
  const row = db.prepare("select * from queue_state where queue_id = ?").get(queueId);
  return row ? (row as unknown as QueueState) : null;
}

/** Replaces the queue's state. The parameter names are the column names. */
export function saveQueueState(db: Db, queue: QueueState): void {
  db.prepare(
    `insert or replace into queue_state
       (queue_id, tickets_waiting, longest_wait_sec, sla_target_sec, agents_available,
        agents_on_call, volume_last_15m, volume_forecast_next_15m, last_event_ts)
     values
       (:queue_id, :tickets_waiting, :longest_wait_sec, :sla_target_sec, :agents_available,
        :agents_on_call, :volume_last_15m, :volume_forecast_next_15m, :last_event_ts)`,
  ).run({ ...queue });
}

/** Time of the newest event applied for this agent, or null if there is none. */
export function getAgentLastEventTs(db: Db, agentId: string): number | null {
  const row = db.prepare("select last_event_ts from agent_state where agent_id = ?").get(agentId);
  return row ? (row.last_event_ts as number) : null;
}

/** Records the time of the newest event applied for this agent. */
export function saveAgentLastEventTs(db: Db, agentId: string, ts: number): void {
  db.prepare("insert or replace into agent_state (agent_id, last_event_ts) values (?, ?)").run(
    agentId,
    ts,
  );
}

/** The incident for this rule and subject that has not closed, if any. */
export function getLiveIncident(db: Db, ruleId: string, subjectId: string): Incident | null {
  const row = db
    .prepare("select * from incidents where rule_id = ? and subject_id = ? and status <> 'closed'")
    .get(ruleId, subjectId);
  return row ? (row as unknown as Incident) : null;
}

/** Saves a new incident and returns its id. */
export function insertIncident(db: Db, incident: NewIncident): number {
  const result = db
    .prepare(
      `insert into incidents (rule_id, subject_id, status, started_at, opened_at)
       values (?, ?, ?, ?, ?)`,
    )
    .run(
      incident.rule_id,
      incident.subject_id,
      incident.status,
      incident.started_at,
      incident.opened_at,
    );
  return Number(result.lastInsertRowid);
}

/** Saves a notification for an incident and returns the stored row. */
export function insertNotification(
  db: Db,
  incidentId: number,
  notification: NewNotification,
): Notification {
  const result = db
    .prepare(
      `insert into notifications (incident_id, recipient_id, kind, seq, at, message, detail)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      incidentId,
      notification.recipient_id,
      notification.kind,
      notification.seq,
      notification.at,
      notification.message,
      JSON.stringify(notification.detail),
    );
  return { ...notification, id: Number(result.lastInsertRowid), incident_id: incidentId };
}

/** How many incidents have not closed. */
export function countLiveIncidents(db: Db): number {
  const row = db.prepare("select count(*) as n from incidents where status <> 'closed'").get();
  return row!.n as number;
}
