// The sentence box above the rule form. The assistant turns a sentence into a draft
// that fills the form; the person checks it and saves it themselves. Without an
// OpenAI key on the server, the box stays visible but disabled, and says why.

import { useState } from "react";

import { type RuleDraft, draftFromSentence } from "./api.ts";

interface Props {
  enabled: boolean;
  viewer: string;
  onDraft: (draft: RuleDraft) => void;
}

export function Assistant({ enabled, viewer, onDraft }: Props) {
  const [sentence, setSentence] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [filled, setFilled] = useState(false);

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setFilled(false);
    try {
      const result = await draftFromSentence(viewer, sentence);
      if ("draft" in result) {
        setErrors([]);
        setFilled(true);
        onDraft(result.draft);
      } else {
        setErrors(result.errors);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="assistant" onSubmit={submit}>
      <label htmlFor="sentence">Describe when you want to be notified</label>
      <div className="row">
        <input
          id="sentence"
          type="text"
          value={sentence}
          placeholder="ping me if any of my agents is on a call for 45 minutes"
          disabled={!enabled || busy}
          onChange={(e) => setSentence(e.target.value)}
        />
        <button type="submit" disabled={!enabled || busy || sentence.trim() === ""}>
          {busy ? "Thinking…" : "Create Rule"}
        </button>
      </div>
      {!enabled && <p className="note">Set OPENAI_API_KEY and OPENAI_MODEL in .env to use this.</p>}
      {filled && <p className="saved">Your rule has been drafted below! Review and save it.</p>}
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
    </form>
  );
}
