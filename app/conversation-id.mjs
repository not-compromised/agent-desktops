export function conversationId(sourceHost, threadId) {
  return threadId ? `${sourceHost}/${threadId}` : null;
}
