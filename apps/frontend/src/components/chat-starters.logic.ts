// The starters that the empty chat offers. A starter is fixed text of the app.
// A click puts the draft in the message box (widget-draft.tsx) and sends
// nothing. The text of a draft does not name a file, a tool, an integration,
// or a result, and it asks the agent to ask the user for what is missing. So it
// is true in every chat, and the agent has nothing to take from it but the
// request. The starters show the views that the chat can make: a Checklist, a
// ComparisonTable, a StatusSummary, and the side panel.

export type ChatStarter = {
  id: string;
  /** The name of the task on the button. */
  label: string;
  /** One short line under the label that says what the draft asks for. */
  hint: string;
  /** The text that goes in the message box. */
  draft: string;
};

/** The bounds that a test holds the starters to. A starter has to fit a phone. */
export const STARTER_LIMITS = { count: 4, label: 32, hint: 40, draft: 220 } as const;

const NO_INVENTING = "Do not invent details that I did not give you.";

export const CHAT_STARTERS: readonly ChatStarter[] = [
  {
    id: "checklist",
    label: "Build a checklist",
    hint: "Steps you can tick off",
    draft: `Help me build a checklist that I can tick off. First ask me what it is for and which steps it needs. ${NO_INVENTING}`
  },
  {
    id: "comparison",
    label: "Compare options",
    hint: "Side by side in a table",
    draft: `Help me compare some options in a table. First ask me which options to compare and which criteria matter to me. ${NO_INVENTING}`
  },
  {
    id: "status",
    label: "Summarize status",
    hint: "Where each item stands",
    draft: "Help me write a status summary. First ask me which items to track and where each one stands. "
      + "Do not invent a status or a count that I did not give you."
  },
  {
    id: "side-panel",
    label: "Use the side panel",
    hint: "A view beside the chat",
    draft: `Help me make a view that I can keep open in the side panel, next to our chat. First ask me what the view should show. ${NO_INVENTING}`
  }
];
