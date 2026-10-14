/** Claude emits this refresh-lock failure as an assistant server_error before its result. */
export const CLAUDE_OAUTH_REFRESH_ERROR = 'Claude OAuth token refresh failed';

export function isClaudeOAuthRefreshError(text: string): boolean {
  return text.includes('Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh')
    || text.includes('Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh)');
}

export function claudeOAuthRefreshError(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return;
  const event = message as Record<string, unknown>;
  // Ordinary responses and subagent messages can quote an error without being this failure.
  if (event.type !== 'assistant' || event.error !== 'server_error' || event.parent_tool_use_id !== null) return;
  const body = event.message as { content?: unknown } | undefined;
  if (!Array.isArray(body?.content)) return;
  const text = body.content.flatMap(block => block && typeof block === 'object'
    && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
  return isClaudeOAuthRefreshError(text) ? text : undefined;
}
