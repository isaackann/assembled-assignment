// The scheduled function: run by the platform's scheduler every 30 seconds (a cron
// job, or a scheduled cloud function). It fires the incident timers that came due:
// openings after a "for", follow-ups, and closings after the settle time. Without it,
// a quiet feed would leave incidents silent.
//
// It only reads incidents that are due (the incidents_due index), so a missed run is
// picked up by the next one. A deadline can fire up to one run late; it is still
// stamped with its due time. If an event for that incident arrives first, the
// webhook settles the deadline before applying the event, so lateness never changes
// what is sent.

import { tick } from "../ingest.ts";
import type { Db } from "../store/store.ts";
import type { Clock, Deliver } from "./clock.ts";

export function runTick(db: Db, clock: Clock, deliver: Deliver): void {
  deliver(tick(db, clock.now()), "ticker");
}
