import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { Session } from '../../core/session';

interface ClaudeResult {
  body: string;
  status: 'completed' | 'error';
  detail?: string;
}

/** An assistant message is not a result. A bound query has exactly one foreground turn. */
export function acceptClaudeResult(session: Session, requestId: string, message: SDKResultMessage, connectionId: string): void {
  assertResultIdentity(session, requestId, message);
  const { body, status, detail } = toClaudeResult(message);
  session.body(requestId, body, connectionId);
  session.finish(requestId, status, connectionId, detail, message.uuid);
}

function assertResultIdentity(session: Session, requestId: string, message: SDKResultMessage): void {
  if (message.session_id !== session.binding.sessionId) {
    throw new Error('Claude session identity mismatch');
  }
  if (!message.uuid || (message.user_message_uuid && message.user_message_uuid !== requestId)) {
    throw new Error('Claude result is not bound to this execution');
  }
}

function toClaudeResult(message: SDKResultMessage): ClaudeResult {
  if (message.subtype === 'success') {
    if (message.is_error === false) {
      return { body: message.result, status: 'completed' };
    }
    return { body: message.result, status: 'error', detail: message.subtype };
  }

  const detail = message.subtype === 'error_max_turns'
    ? 'Execution turn limit reached (not account quota)'
    : message.subtype;
  return { body: message.errors.join('\n'), status: 'error', detail };
}
