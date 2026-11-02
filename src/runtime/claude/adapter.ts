// Claude SDK 결과의 실행 식별자를 검증하고 세션 본문·종료 상태로 변환한다.
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { Session } from '../../core/session';

interface ClaudeResult {
  body: string;
  status: 'completed' | 'error';
  detail?: string;
}

/** 같은 세션·요청의 result로 한 번의 사용자 실행을 종료하며 assistant 메시지는 제외한다. */
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

// result의 subtype과 is_error를 함께 확인해 성공·오류를 구분한다.
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
