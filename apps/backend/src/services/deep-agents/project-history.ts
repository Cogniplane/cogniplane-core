// Model input for the saved history of a project chat. Several members write
// to one project chat, and each turn rebuilds the history from saved messages
// (no checkpoint). Without a label, the model reads every earlier user message
// as a request of the member who sends the current one.
//
// The server writes the label from the author id of the saved row. It never
// reads a label, a name or any other text from message content. A message can
// contain text that looks like a label; the server label always comes first.
// The label tells the model whose request a message was. It does not stop the
// model from following text in another member's message. The boundary for
// that is that project turns get no personal authority
// (services/personal-authority.ts).

export type ProjectHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  userId: string;
};

const CURRENT_MEMBER_LABEL = "[Project chat history: message from the member you are helping now.]";

function otherMemberLabel(ordinal: number): string {
  return `[Project chat history: message from another project member (member ${ordinal}), ` +
    "not from the member you are helping now.]";
}

/**
 * Adds the author label to each user message. Other members get a number in
 * the order in which they first wrote, so the label shows no name or account
 * text. Assistant messages stay as they were saved.
 */
export function labelProjectHistory(
  messages: readonly ProjectHistoryMessage[],
  actingUserId: string
): Array<{ role: "user" | "assistant"; content: string }> {
  const ordinals = new Map<string, number>();
  return messages.map(({ role, content, userId }) => {
    if (role !== "user") return { role, content };
    if (userId === actingUserId) return { role, content: `${CURRENT_MEMBER_LABEL}\n\n${content}` };
    let ordinal = ordinals.get(userId);
    if (ordinal === undefined) {
      ordinal = ordinals.size + 1;
      ordinals.set(userId, ordinal);
    }
    return { role, content: `${otherMemberLabel(ordinal)}\n\n${content}` };
  });
}
