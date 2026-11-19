// The rules page. There is no login, so "Viewing as" says who "me" is. The page
// shows that person's rules, the form to add one, and the notifications sent to
// them, refreshed every 2 seconds while the feed plays.

import { useCallback, useEffect, useState } from "react";

import {
  type Catalog,
  type Directory,
  type Notification,
  type SavedRule,
  type SimulationStatus,
  deleteRule,
  getCatalog,
  getDirectory,
  getNotifications,
  getRules,
  type RuleDraft,
  getAssistant,
  getSimulation,
  startFeed,
} from "./api.ts";
import { Assistant } from "./Assistant.tsx";
import { RuleForm } from "./RuleForm.tsx";

const REFRESH_MS = 2000;

export function App() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [viewer, setViewer] = useState("lead_1");
  const [rules, setRules] = useState<SavedRule[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [simulation, setSimulation] = useState<SimulationStatus>({ started: false, now: null });
  const [assistantOn, setAssistantOn] = useState(false);
  // The assistant's latest draft, and a count so each new draft refills the form.
  const [draft, setDraft] = useState<{ rule: RuleDraft; n: number } | null>(null);

  useEffect(() => {
    getDirectory().then(setDirectory);
    getCatalog().then(setCatalog);
    getAssistant().then((status) => setAssistantOn(status.enabled));
  }, []);

  const changeViewer = (next: string) => {
    setViewer(next);
    setDraft(null);
  };

  const loadRules = useCallback(() => getRules(viewer).then(setRules), [viewer]);
  useEffect(() => {
    loadRules();
  }, [loadRules]);

  useEffect(() => {
    const refresh = () => {
      getNotifications(viewer).then(setNotifications);
      getSimulation().then(setSimulation);
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [viewer]);

  if (!directory || !catalog) return <p className="loading">Loading…</p>;

  const onStart = async () => {
    await startFeed();
    setSimulation(await getSimulation());
  };
  const onDelete = async (id: string) => {
    await deleteRule(id);
    loadRules();
  };

  return (
    <div className="page">
      <header>
        <h1>Notifications HQ</h1>
        <label>
          Viewing as{" "}
          <select value={viewer} onChange={(e) => changeViewer(e.target.value)}>
            {directory.teams.map((team) => (
              <optgroup key={team.id} label={team.id}>
                <option value={team.lead_id}>{team.lead_id} (lead)</option>
                {team.agent_ids.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="feed">
          <span className="clock">
            {simulation.now === null ? "Feed not started" : `Feed at ${timeOfDay(simulation.now)}`}
          </span>
          <button onClick={onStart} disabled={simulation.started}>
            {simulation.started ? "Feed running" : "Start feed"}
          </button>
        </div>
      </header>

      <main>
        <section>
          <h2>Your rules</h2>
          {rules.length === 0 && <p className="empty">No rules yet.</p>}
          <ul className="rules">
            {rules.map((rule) => (
              <li key={rule.id}>
                <div>
                  <strong>{subjectWords(rule)}</strong>: {rule.description}
                </div>
                <button className="quiet" onClick={() => onDelete(rule.id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>

          <h2>New rule</h2>
          <Assistant
            key={`assistant-${viewer}`}
            enabled={assistantOn}
            viewer={viewer}
            onDraft={(rule) => setDraft({ rule, n: (draft?.n ?? 0) + 1 })}
          />
          <RuleForm
            key={`${viewer}-${draft?.n ?? 0}`}
            initial={draft?.rule ?? null}
            viewer={viewer}
            directory={directory}
            catalog={catalog}
            onSaved={loadRules}
          />
        </section>

        <section>
          <h2>Your notifications</h2>
          {notifications.length === 0 && <p className="empty">Nothing yet.</p>}
          <ul className="notifications">
            {[...notifications].reverse().map((n) => (
              <li key={n.id} className={n.kind}>
                <span className="time">{timeOfDay(n.at)}</span>
                <span className="kind">{n.kind.replace("_", "-")}</span>
                <span>{n.message}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

/** "team_1", "billing, tier_2", "a_19". */
function subjectWords(rule: SavedRule): string {
  const plural = rule.subject.resource_ids.length > 1 ? "s" : "";
  return `${rule.subject.kind}${plural} ${rule.subject.resource_ids.join(", ")}`;
}

/** 09:35:00, in UTC like the feed. */
function timeOfDay(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}
