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

-- One row per agent: what they are doing and since when, since when they have been
-- out of adherence (null while in adherence), and the time of the newest event applied.
create table agent_state (
  agent_id        text primary key,
  state           text not null,
  state_since     integer not null,
  violation_since integer,
  last_event_ts   integer not null
);

-- The seeded directory. An agent's user id is its agent_id in the feed. A team
-- has one lead; each agent is on one team. Queues are the ones a rule may name.
create table queues (
  id text primary key
);

create table teams (
  id      text primary key,
  lead_id text not null
);

create table users (
  id      text primary key,
  role    text not null check (role in ('lead', 'agent')),
  team_id text references teams (id)
);

-- Subject ({ kind, resource_ids }) and conditions are JSON: they are always read
-- and written whole with the rule. A deleted rule keeps its row (deleted_at is
-- set), because its incidents and notifications still point at it.
create table rules (
  id          text primary key,
  owner_id    text not null,
  subject     text not null,
  conditions  text not null,
  for_seconds integer not null default 0,
  deleted_at  integer
);

-- One rule being true for one subject. Pending: holding, but not yet for long
-- enough. Settling: no longer true, waiting out the settle time. next_due_at is
-- when the incident's timer fires (open it, follow up, or close it). opened_values
-- is JSON: the tested fields' values when it opened, by field name.
create table incidents (
  id               integer primary key,
  rule_id          text not null references rules (id),
  subject_id       text not null,
  status           text not null check (status in ('pending', 'open', 'settling', 'closed')),
  started_at       integer not null,
  opened_at        integer,
  last_notified_at integer,
  next_due_at      integer,
  follow_ups       integer not null default 0,
  opened_values    text,
  closed_at        integer
);

-- At most one live incident per rule and subject.
create unique index incidents_live on incidents (rule_id, subject_id) where status <> 'closed';

-- The timer reads live incidents by due time.
create index incidents_due on incidents (next_due_at) where status <> 'closed';

-- Written in the same transaction as the incident change that caused them, so the
-- two cannot drift apart. The unique key means a retry cannot double-send.
create table notifications (
  id           integer primary key,
  incident_id  integer not null references incidents (id),
  recipient_id text not null,
  kind         text not null check (kind in ('opened', 'follow_up', 'closed')),
  seq          integer not null,
  at           integer not null,
  message      text not null,
  detail       text not null,
  unique (incident_id, kind, seq)
);
