import { boundedText, Signal } from './model';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string => typeof value === 'string' ? boundedText(value, 2048).text.replace(/\s+/gu, ' ').trim() : '';

/** Question previews retain the question and numbered choice labels, never opaque tool arguments. */
export function inputQuestionText(questions: unknown, fallback: string): string {
  if (!Array.isArray(questions)) return boundedText(fallback).text;
  const previews = questions.slice(0, 8).flatMap(value => {
    const question = record(value); if (!question) return [];
    const title = text(question.question) || text(question.title);
    if (!title) return [];
    const choices = Array.isArray(question.options) ? question.options.slice(0, 8)
      .map(option => text(typeof option === 'string' ? option : record(option)?.label)).filter(Boolean) : [];
    return [[title, ...choices.map((choice, index) => `${index + 1}. ${choice}`)].join('\n')];
  });
  return boundedText(previews.join('\n') || fallback).text;
}

export function notificationTitle(signal: Signal): string {
  const provider = signal.provider === 'codex' ? 'Codex' : 'Claude';
  const status = signal.status === 'waitingForInput'
    ? signal.inputKind === 'approval' ? 'Approval needed' : 'Answer needed'
    : signal.status;
  return `${provider} · ${status} · ${signal.windowInstanceId.slice(0, 8)}`;
}
