// The only file that talks to SQLite. Each function is one read or one write;
// the decisions about what to read and write live in the engine and in ingest.ts.
// Statements are prepared on each call, which is fine at this size and keeps
// every function readable on its own.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { Incident, NewIncident, NewNotification } from "../engine/incidents.ts";
import type { FeedEvent } from "../engine/normalize.ts";
import type { AgentState, QueueState } from "../shared/catalog.ts";
import type { Directory } from "../shared/directory.ts";
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
    `insert into rules (id, owner_id, subject, conditions, for_seconds)
     values (?, ?, ?, ?, ?)`,
  );
  for (const rule of rules) {
    insert.run(
      rule.id,
      rule.owner_id,
      JSON.stringify(rule.subject),
      JSON.stringify(rule.conditions),
      rule.for_seconds,
    );
  }
}

/** Every rule. */
export function listRules(db: Db): Rule[] {
  const rows = db.prepare("select * from rules order by id").all() as Row[];
  return rows.map(toRule);
}

/** One rule by id, or null. */
export function getRule(db: Db, ruleId: string): Rule | null {
  const row = db.prepare("select * from rules where id = ?").get(ruleId);
  return row ? toRule(row) : null;
}

function toRule(row: Row): Rule {
  return {
    id: row.id as string,
    owner_id: row.owner_id as string,
    subject: JSON.parse(row.subject as string),
    conditions: JSON.parse(row.conditions as string),
    for_seconds: row.for_seconds as number,
  };
}

/** Saves the directory: each team, its lead, and its agents. */
export function seedDirectory(db: Db, directory: Directory): void {
  const insertTeam = db.prepare("insert into teams (id, lead_id) values (?, ?)");
  const insertUser = db.prepare("insert into users (id, role, team_id) values (?, ?, ?)");
  for (const team of directory.teams) {
    insertTeam.run(team.id, team.lead_id);
    insertUser.run(team.lead_id, "lead", null);
    for (const agentId of team.agent_ids) insertUser.run(agentId, "agent", team.id);
  }
}

/** The agents on any of these teams, by team id. */
export function listTeamAgentIds(db: Db, teamIds: string[]): string[] {
  const select = db.prepare(
    "select id from users where team_id = ? and role = 'agent' order by id",
  );
  return teamIds.flatMap((teamId) => (select.all(teamId) as Row[]).map((row) => row.id as string));
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

/** The agent's current state, or null if no event has been applied for them. */
export function getAgentState(db: Db, agentId: string): AgentState | null {
  const row = db.prepare("select * from agent_state where agent_id = ?").get(agentId);
  return row ? (row as unknown as AgentState) : null;
}

/** Replaces the agent's state. */
export function saveAgentState(db: Db, agent: AgentState): void {
  db.prepare(
    `insert or replace into agent_state
       (agent_id, state, state_since, violation_since, last_event_ts)
     values (?, ?, ?, ?, ?)`,
  ).run(
    agent.agent_id,
    agent.state,
    agent.state_since,
    agent.violation_since,
    agent.last_event_ts,
  );
}

/** The incident for this rule and subject that has not closed, if any. */
export function getLiveIncident(db: Db, ruleId: string, subjectId: string): Incident | null {
  const row = db
    .prepare("select * from incidents where rule_id = ? and subject_id = ? and status <> 'closed'")
    .get(ruleId, subjectId);
  return row ? toIncident(row) : null;
}

/** The live incident with the earliest due time at or before `clock`, or null if none is due. */
export function nextDueIncident(db: Db, clock: number): Incident | null {
  const row = db
    .prepare(
      `select * from incidents where status <> 'closed' and next_due_at <= ?
       order by next_due_at, id limit 1`,
    )
    .get(clock);
  return row ? toIncident(row) : null;
}

/** Every incident that has not closed, by rule and subject. */
export function listLiveIncidents(db: Db): Incident[] {
  const rows = db
    .prepare("select * from incidents where status <> 'closed' order by rule_id, subject_id")
    .all() as Row[];
  return rows.map(toIncident);
}

// opened_values is stored as JSON text.
function toIncident(row: Row): Incident {
  const opened = row.opened_values as string | null;
  return { ...(row as unknown as Incident), opened_values: opened ? JSON.parse(opened) : null };
}

/** Saves a new incident and returns its id. The parameter names are the column names. */
export function insertIncident(db: Db, incident: NewIncident): number {
  const result = db
    .prepare(
      `insert into incidents
         (rule_id, subject_id, status, started_at, opened_at, last_notified_at, next_due_at,
          follow_ups, opened_values, closed_at)
       values
         (:rule_id, :subject_id, :status, :started_at, :opened_at, :last_notified_at, :next_due_at,
          :follow_ups, :opened_values, :closed_at)`,
    )
    .run({ ...incident, opened_values: openedValuesJson(incident) });
  return Number(result.lastInsertRowid);
}

/** Replaces everything about an incident except which rule and subject it is for. */
export function updateIncident(db: Db, id: number, incident: NewIncident): void {
  db.prepare(
    `update incidents set
       status = :status, started_at = :started_at, opened_at = :opened_at,
       last_notified_at = :last_notified_at, next_due_at = :next_due_at,
       follow_ups = :follow_ups, opened_values = :opened_values, closed_at = :closed_at
     where id = :id`,
  ).run({
    id,
    status: incident.status,
    started_at: incident.started_at,
    opened_at: incident.opened_at,
    last_notified_at: incident.last_notified_at,
    next_due_at: incident.next_due_at,
    follow_ups: incident.follow_ups,
    opened_values: openedValuesJson(incident),
    closed_at: incident.closed_at,
  });
}

function openedValuesJson(incident: NewIncident): string | null {
  return incident.opened_values ? JSON.stringify(incident.opened_values) : null;
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
