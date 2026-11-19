// The shape of data/directory.json: which agents are on which team, and who leads
// it. A team rule names teams by id; their agents are read from here when an
// event arrives.

/** One team: a lead and the agents they look after. */
export interface Team {
  id: string;
  lead_id: string;
  agent_ids: string[];
}

/** Everyone the system knows about, by team. */
export interface Directory {
  teams: Team[];
}
