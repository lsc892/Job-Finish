import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { Session } from '../core/session';

/** An assistant message is not a result. A bound query has exactly one foreground turn. */
export function acceptClaudeResult(session: Session, requestId: string, message: SDKResultMessage, connectionId: string): void {
  if (message.session_id !== session.binding.sessionId) throw new Error('Claude session identity mismatch');
  if (!message.uuid || (message.user_message_uuid && message.user_message_uuid !== requestId)) throw new Error('Claude result is not bound to this execution');
  const success = message.subtype === 'success' && message.is_error === false;
  const body = message.subtype === 'success' ? message.result : message.errors.join('\n');
  session.body(requestId, body, connectionId);
  session.finish(requestId, success ? 'completed' : 'error', connectionId,
    success ? undefined : message.subtype === 'error_max_turns' ? 'Execution turn limit reached (not account quota)' : message.subtype, message.uuid);
}
