// The form for a new rule. Every choice comes from the catalog and the directory,
// so a new catalog field shows up here with no change. "Me" and "My team" are
// shortcuts that fill in what the rule watches; the rule itself stores ids. The API
// checks the rule (validateRule) and its reasons are shown here as they come back.

import { useState } from "react";

import {
  type Catalog,
  type CatalogField,
  type Condition,
  type Directory,
  type RuleDraft,
  createRule,
} from "./api.ts";

type Kind = RuleDraft["subject"]["kind"];

const OP_WORDS: Record<Condition["op"], string> = {
  ">": "above",
  ">=": "at least",
  "<": "below",
  "<=": "at most",
  "=": "is",
  in: "is one of",
};

interface Props {
  viewer: string;
  directory: Directory;
  catalog: Catalog;
  /** A draft to start from (the assistant's), instead of an empty form. */
  initial: RuleDraft | null;
  onSaved: () => void;
}

export function RuleForm({ viewer, directory, catalog, initial, onSaved }: Props) {
  const myTeam = directory.teams.find((team) => team.lead_id === viewer);
  const isAgent = directory.teams.some((team) => team.agent_ids.includes(viewer));

  const [kind, setKind] = useState<Kind>(initial?.subject.kind ?? (myTeam ? "team" : "agent"));
  const [ids, setIds] = useState<string[]>(
    initial?.subject.resource_ids ?? (myTeam ? [myTeam.id] : isAgent ? [viewer] : []),
  );
  const fields = catalog[kind === "queue" ? "queue" : "agent"];
  const [conditions, setConditions] = useState<Condition[]>(
    initial?.conditions ?? [firstCondition(fields[0]!)],
  );
  const [minutes, setMinutes] = useState(initial ? initial.for_seconds / 60 : 0);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const choices: Record<Kind, string[]> = {
    queue: directory.queues,
    agent: directory.teams.flatMap((team) => team.agent_ids),
    team: directory.teams.map((team) => team.id),
  };

  const changeKind = (next: Kind, nextIds: string[] = []) => {
    const sameFields = (next === "queue") === (kind === "queue");
    setKind(next);
    setIds(nextIds);
    if (!sameFields)
      setConditions([firstCondition(catalog[next === "queue" ? "queue" : "agent"][0]!)]);
  };

  const toggleId = (id: string) =>
    setIds(ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]);

  const setCondition = (index: number, next: Condition) =>
    setConditions(conditions.map((c, i) => (i === index ? next : c)));

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problems = await createRule({
      owner_id: viewer,
      subject: { kind, resource_ids: ids },
      conditions,
      for_seconds: Math.round(minutes * 60),
    });
    setErrors(problems);
    setSaved(problems.length === 0);
    if (problems.length === 0) onSaved();
  };

  return (
    <form className="rule-form" onSubmit={submit}>
      <fieldset>
        <legend>Watch</legend>
        <div className="shortcuts">
          {isAgent && (
            <button type="button" onClick={() => changeKind("agent", [viewer])}>
              Me
            </button>
          )}
          {myTeam && (
            <button type="button" onClick={() => changeKind("team", [myTeam.id])}>
              My team
            </button>
          )}
          <select value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
            <option value="queue">Queues</option>
            <option value="agent">Agents</option>
            <option value="team">Teams</option>
          </select>
        </div>
        <div className="ids">
          {choices[kind].map((id) => (
            <label key={id}>
              <input type="checkbox" checked={ids.includes(id)} onChange={() => toggleId(id)} />
              {id}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>When all of these hold</legend>
        {conditions.map((condition, index) => (
          <ConditionRow
            key={index}
            fields={fields}
            condition={condition}
            onChange={(next) => setCondition(index, next)}
            onRemove={
              conditions.length > 1
                ? () => setConditions(conditions.filter((_, i) => i !== index))
                : undefined
            }
          />
        ))}
        <button
          type="button"
          className="quiet"
          onClick={() => setConditions([...conditions, firstCondition(fields[0]!)])}
        >
          + Add condition
        </button>
      </fieldset>

      <fieldset>
        <legend>For at least</legend>
        <label>
          <input
            type="number"
            min={0}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />{" "}
          minutes (0 tells you as soon as it holds)
        </label>
      </fieldset>

      <p className="who">Notifications go to {viewer}.</p>
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {saved && <p className="saved">Saved. It applies from the next event.</p>}
      <button type="submit">Save rule</button>
    </form>
  );
}

interface RowProps {
  fields: CatalogField[];
  condition: Condition;
  onChange: (next: Condition) => void;
  onRemove?: () => void;
}

function ConditionRow({ fields, condition, onChange, onRemove }: RowProps) {
  const field = fields.find((f) => f.name === condition.field) ?? fields[0]!;

  return (
    <div className="condition">
      <select
        value={field.name}
        onChange={(e) => onChange(firstCondition(fields.find((f) => f.name === e.target.value)!))}
      >
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        value={condition.op}
        onChange={(e) => onChange(changeOp(field, condition, e.target.value as Condition["op"]))}
      >
        {field.operators.map((op) => (
          <option key={op} value={op}>
            {OP_WORDS[op]}
          </option>
        ))}
      </select>
      <ValueInput field={field} condition={condition} onChange={onChange} />
      {onRemove && (
        <button type="button" className="quiet" onClick={onRemove}>
          Remove
        </button>
      )}
    </div>
  );
}

function ValueInput({
  field,
  condition,
  onChange,
}: Omit<RowProps, "fields"> & { field: CatalogField }) {
  if (condition.op === "in") {
    const chosen = condition.value;
    return (
      <span className="ids">
        {(field.values ?? []).map((value) => (
          <label key={value}>
            <input
              type="checkbox"
              checked={chosen.includes(value)}
              onChange={() =>
                onChange({
                  ...condition,
                  value: chosen.includes(value)
                    ? chosen.filter((v) => v !== value)
                    : [...chosen, value],
                })
              }
            />
            {value}
          </label>
        ))}
      </span>
    );
  }
  if (field.type === "boolean") {
    return (
      <select
        value={String(condition.value)}
        onChange={(e) => onChange({ field: field.name, op: "=", value: e.target.value === "true" })}
      >
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    );
  }
  if (field.type === "string") {
    return (
      <select
        value={String(condition.value)}
        onChange={(e) => onChange({ field: field.name, op: "=", value: e.target.value })}
      >
        {(field.values ?? []).map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </select>
    );
  }
  return (
    <label>
      <input
        type="number"
        value={Number(condition.value)}
        onChange={(e) => onChange({ ...condition, value: Number(e.target.value) } as Condition)}
      />
      {field.unit ?? ""}
    </label>
  );
}

/** A starting condition for a field: its first operator and a sensible value. */
function firstCondition(field: CatalogField): Condition {
  return withOp(field, field.operators[0]!);
}

/** A new operator on the same field. A number survives a switch between comparisons. */
function changeOp(field: CatalogField, condition: Condition, op: Condition["op"]): Condition {
  const comparison = (o: Condition["op"]) => o !== "=" && o !== "in";
  if (comparison(op) && comparison(condition.op)) return { ...condition, op } as Condition;
  return withOp(field, op);
}

function withOp(field: CatalogField, op: Condition["op"]): Condition {
  if (op === "in") return { field: field.name, op, value: [] };
  if (op === "=") {
    if (field.type === "boolean") return { field: field.name, op, value: true };
    return { field: field.name, op, value: field.values?.[0] ?? "" };
  }
  return { field: field.name, op, value: 0 };
}
