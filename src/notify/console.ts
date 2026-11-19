// The stand-in for Slack, email or push: prints each notification where a person
// running the replay can see it. Real delivery is out of scope; what matters is
// that the right message reaches the right recipient for a visible reason.

import { formatTime } from "../engine/normalize.ts";
import type { Notification } from "../store/store.ts";

/** Prints notifications: when, kind, who it is for, why, then the subject's state behind it. */
export function printNotifications(notifications: Notification[]): void {
  for (const notification of notifications) {
    const kind = notification.kind.replace("_", "-").toUpperCase();
    const detail = Object.entries(notification.detail)
      .map(([name, value]) => `${name}=${value ?? "unknown"}`)
      .join("  ");

    console.log(
      `${formatTime(notification.at)}  ${kind}  to ${notification.recipient_id}  ${notification.message}`,
    );
    console.log(`    ${detail}`);
  }
}
