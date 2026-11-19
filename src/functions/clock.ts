// Where a deployed function gets "now". The engine never reads the system clock; the
// function reads it once per call and passes it in. In production this is
// `{ now: Date.now }`. The simulator passes a clock it moves itself, because the
// sample feed is dated 2026-05-26.

import type { Notification } from "../store/store.ts";

export interface Clock {
  now(): number;
}

/** Who handed a notification over: the events webhook or the scheduled tick. */
export type Source = "webhook" | "ticker";

/** Hands notifications to delivery (the console stub), labelled with their source. */
export type Deliver = (notifications: Notification[], source: Source) => void;
