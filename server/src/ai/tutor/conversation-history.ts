export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationTurn {
  user: string;
  assistant: string;
}

/** Keep only complete adjacent user/assistant turns for Field 2 history. */
export function selectRecentCompleteTurns(
  messages: readonly ConversationMessage[],
  maxTurns = 6,
): ConversationTurn[] {
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) return [];

  const turns: ConversationTurn[] = [];
  for (let index = 0; index < messages.length - 1;) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (user.role === 'user' && assistant.role === 'assistant') {
      turns.push({ user: user.content, assistant: assistant.content });
      index += 2;
    } else {
      index += 1;
    }
  }
  return turns.slice(-maxTurns);
}
