-- All times are epoch milliseconds (UTC). In Postgres these would be timestamptz.
-- There is no customer id: multi-tenancy is out of scope. In production every
-- table gains one as the leading part of its key.

-- Every event that was accepted. The primary key is the dedupe: a second event
-- with the same id cannot be inserted. Late events are kept (outcome 'late') but
-- change nothing. Duplicates and malformed lines are reported, not stored.
create table events (
  event_id   text primary key,
  ts         integer not null,
  type       text not null,
  subject_id text not null,
  outcome    text not null check (outcome in ('applied', 'late')),
  payload    text not null
);

-- One row per queue: its latest snapshot and the time of the newest event applied.
create table queue_state (
  queue_id                 text primary key,
  tickets_waiting          integer not null,
  longest_wait_sec         integer not null,
  sla_target_sec           integer not null,
  agents_available         integer not null,
  agents_on_call           integer not null,
  volume_last_15m          integer not null,
  volume_forecast_next_15m integer,
  last_event_ts            integer not null
);

-- One row per agent. Only the newest event time so far, which is what the late
-- check needs. The agent's state and adherence columns are not built yet.
create table agent_state (
  agent_id      text primary key,
  last_event_ts integer not null
);

-- Scope and conditions are JSON: they are always read and written whole with the rule.
create table rules (
  id         text primary key,
  owner_id   text not null,
  subject    text not null,
  scope      text not null,
  conditions text not null
);

-- One rule being true for one subject.
create table incidents (
  id         integer primary key,
  rule_id    text not null references rules (id),
  subject_id text not null,
  status     text not null,
  started_at integer not null,
  opened_at  integer not null
);

-- At most one live incident per rule and subject.
create unique index incidents_live on incidents (rule_id, subject_id) where status <> 'closed';

-- Written in the same transaction as the incident change that caused them, so the
-- two cannot drift apart. The unique key means a retry cannot double-send.
create table notifications (
  id           integer primary key,
  incident_id  integer not null references incidents (id),
  recipient_id text not null,
  kind         text not null,
  seq          integer not null,
  at           integer not null,
  message      text not null,
  detail       text not null,
  unique (incident_id, kind, seq)
);
