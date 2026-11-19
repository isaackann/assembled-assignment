// Applies an event to what we know about its subject.
// A queue snapshot is a full report, so the new state is simply the snapshot.
// An agent's state is built up: state changes say what the agent is doing and
// since when; adherence checks say whether that breaks their schedule, and can
// correct the state when the state stream missed a transition.

import type { AgentState, QueueState } from "../shared/catalog.ts";
import type { AdherenceCheck, AgentStateChange, QueueSnapshot } from "./normalize.ts";

/** The queue's state after this snapshot. */
export function applyQueueSnapshot(snapshot: QueueSnapshot): QueueState {
  const { event_id, type, ts, ...queue } = snapshot;
  return { ...queue, last_event_ts: ts };
}

/** The agent's state after this event. `prev` is null for the agent's first event. */
export function applyAgentEvent(
  prev: AgentState | null,
  event: AgentStateChange | AdherenceCheck,
): AgentState {
  const reported = event.type === "agent_state_change" ? event.new_state : event.actual_state;

  // A state change always starts the state's clock, even into the same state (a
  // second call straight after the first is a new call). An adherence check that
  // agrees with what we track (most of them) must not reset it. One that disagrees
  // corrects the state; the true start is unknown, so the check's own time is
  // used (a_23 at 10:15:30).
  const checkAgrees =
    event.type === "adherence_check" && prev !== null && prev.state === event.actual_state;
  const base = {
    agent_id: event.agent_id,
    state: reported,
    state_since: checkAgrees ? prev.state_since : event.ts,
    last_event_ts: event.ts,
  };

  if (event.type === "agent_state_change") {
    // Only adherence checks report adherence; carry the last known answer forward.
    return { ...base, violation_since: prev?.violation_since ?? null };
  }

  return { ...base, violation_since: violationSince(prev, event) };
}

// The feed's start time when it gives one. With none (a_23), a violation that was
// already being tracked keeps its first start, and a new one starts at this check.
// So an agent out of adherence always has a start, and null means in adherence.
function violationSince(prev: AgentState | null, check: AdherenceCheck): number | null {
  if (!check.in_violation) return null;
  if (check.violation_started_at !== null) return check.violation_started_at;
  return prev?.violation_since ?? check.ts;
}
