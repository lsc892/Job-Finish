// Claude SDK 결과의 실행 식별자를 검증하고 세션 본문·종료 상태로 변환한다.
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { Session } from '../../core/session';

/** 같은 세션·요청의 result로 한 번의 사용자 실행을 종료하며 assistant 메시지는 제외한다. */
export function acceptClaudeResult(session: Session, requestId: string, message: SDKResultMessage, connectionId: string): void {
  if (message.session_id !== session.binding.sessionId) {
    throw new Error('Claude session identity mismatch');
  }
  if (!message.uuid || (message.user_message_uuid && message.user_message_uuid !== requestId)) {
    throw new Error('Claude result is not bound to this execution');
  }
  // result의 subtype과 is_error를 함께 확인해 본문·종료 상태·오류 설명을 반영한다.
  if (message.subtype === 'success') {
    const success = message.is_error === false;
    session.body(requestId, message.result, connectionId);
    session.finish(requestId, success ? 'completed' : 'error', connectionId, success ? undefined : message.subtype, message.uuid);
    return;
  }

  const detail = message.subtype === 'error_max_turns'
    ? 'Execution turn limit reached (not account quota)'
    : message.subtype;
  session.body(requestId, message.errors.join('\n'), connectionId);
  session.finish(requestId, 'error', connectionId, detail, message.uuid);
}
