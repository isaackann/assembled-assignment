// The page's calls to the config API and the simulation's start control. The rule
// and directory types are the server's own (src/shared), so the form cannot drift
// from what the API checks.

import type { Directory } from "../../src/shared/directory.ts";
import type { Condition, Rule } from "../../src/shared/rule.ts";
import type { RuleDraft } from "../../src/shared/validate.ts";

export type { Condition, Directory, Rule, RuleDraft };

/** One catalog field as GET /catalog describes it. */
export interface CatalogField {
  name: string;
  label: string;
  type: "number" | "string" | "boolean";
  unit: string | null;
  values: string[] | null;
  operators: Condition["op"][];
}

export type Catalog = Record<"queue" | "agent", CatalogField[]>;

/** A saved rule, with the sentence its notifications use. */
export type SavedRule = Rule & { description: string };

export interface Notification {
  id: number;
  kind: "opened" | "follow_up" | "closed";
  at: number;
  message: string;
}

export interface SimulationStatus {
  started: boolean;
  /** Simulated time, epoch ms; null before the feed starts. */
  now: number | null;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json() as Promise<T>;
}

export const getDirectory = () => getJson<Directory>("/directory");
export const getCatalog = () => getJson<Catalog>("/catalog");
export const getRules = (owner: string) =>
  getJson<SavedRule[]>(`/rules?owner=${encodeURIComponent(owner)}`);
export const getNotifications = (recipient: string) =>
  getJson<Notification[]>(`/notifications?recipient=${encodeURIComponent(recipient)}`);
export const getSimulation = () => getJson<SimulationStatus>("/simulation");

/** Saves a rule. Resolves to the problems the API found; empty when it was saved. */
export async function createRule(draft: RuleDraft): Promise<string[]> {
  const response = await fetch("/rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
  if (response.ok) return [];
  const body = (await response.json()) as { errors?: string[] };
  return body.errors ?? [`Could not save (${response.status})`];
}

export async function deleteRule(id: string): Promise<void> {
  await fetch(`/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function startFeed(): Promise<void> {
  await fetch("/simulation/start", { method: "POST" });
}
