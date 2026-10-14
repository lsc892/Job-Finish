import { Signal, toastText } from './model';

/** Windows renders plain text; remove Markdown and blank lines only in the preview. Ordered-list numbers stay so choices remain addressable. */
export function toastPlainText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/^[ \t]*(```|~~~)[^\r\n]*$/gm, '')
    .replace(/^[ \t]*(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/!?\[([^\]\r\n]+)\]\([^\r\n)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(?<!\w)([*_])([^*_\r\n]+)\1(?!\w)/g, '$2')
    .replace(/\s+/g, ' ').trim();
}

export function toastTitle(signal: Pick<Signal, 'title' | 'provider'> & Partial<Pick<Signal, 'status' | 'inputKind'>>, fallback = ''): string {
  const title = toastPlainText(signal.title ?? '') || toastPlainText(fallback) || `${signal.provider === 'codex' ? 'Codex' : 'Claude'} 작업`;
  const heading = signal.status === 'waitingForInput'
    ? `${signal.inputKind === 'approval' ? 'Approval needed' : 'Answer needed'} · ${title}` : title;
  const chars = Array.from(heading);
  return chars.length > 100 ? chars.slice(0, 99).join('') + '…' : heading;
}

export function toastMessage(signal: Pick<Signal, 'text' | 'detail' | 'status'>): string {
  const fallback = { completed: '작업이 완료되었습니다.', error: '작업 중 오류가 발생했습니다.', cancelled: '작업이 취소되었습니다.',
    waitingForInput: '응답을 기다리고 있습니다.', unknown: '작업 상태를 확인할 수 없습니다.', idle: '작업 대기 중입니다.', running: '작업이 진행 중입니다.' };
  return toastText(toastPlainText(signal.text) || toastPlainText(signal.detail ?? '') || fallback[signal.status]);
}
