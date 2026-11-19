// The events webhook: the deployed function that receives the live feed, one event
// per request (an HTTP-triggered cloud function, or a queue consumer). The body is
// one raw feed line, exactly as the feed has it.
//
// Responses: 200 for applied, late and duplicate, so the sender does not retry a
// line we already have; 400 for a line that cannot be read. Anything thrown is a 500
// (Express's default), and the event's transaction has rolled back.

import express from "express";

import { handleEvent } from "../ingest.ts";
import type { Db } from "../store/store.ts";
import type { Clock, Deliver } from "./clock.ts";

export function createEventsApp(db: Db, clock: Clock, deliver: Deliver): express.Express {
  const app = express();
  app.use(express.text({ type: "*/*" }));

  app.post("/events", (req, res) => {
    const line = typeof req.body === "string" ? req.body : "";
    const result = handleEvent(db, line, clock.now());
    deliver(result.notifications, "webhook");
    res.status(result.outcome === "rejected" ? 400 : 200).json({
      outcome: result.outcome,
      reason: result.reason,
      notifications: result.notifications.length,
    });
  });

  return app;
}
