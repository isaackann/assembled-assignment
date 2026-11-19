// Applies an event to what we know about its subject.
// A queue snapshot is a full report, so the new state is simply the snapshot.
// Agent state (and correcting it from adherence checks) is not built yet.

import type { QueueState } from "../shared/catalog.ts";
import type { QueueSnapshot } from "./normalize.ts";

/** The queue's state after this snapshot. */
export function applyQueueSnapshot(snapshot: QueueSnapshot): QueueState {
  const { event_id, type, ts, ...queue } = snapshot;
  return { ...queue, last_event_ts: ts };
}
