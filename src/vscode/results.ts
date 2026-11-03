// 자동 감지로 보관한 최근 응답을 표시한다.
import * as vscode from 'vscode';
import type { Signal } from '../core/model';

/** 관찰한 응답을 표시하며 저장 상한으로 잘린 본문은 명시한다. */
export async function showResults(results: readonly Signal[]): Promise<void> {
  const signals = [...results].reverse();
  const choice = await vscode.window.showQuickPick(signals.map(signal => ({ label: `${signal.provider} · ${signal.status}`, description: `${signal.at} · ${signal.sessionId}`, detail: signal.text.slice(0, 120), value: signal })), { title: 'Recent results (up to 20)' });
  if (!choice) return;
  const signal = choice.value;
  const text = signal.text;
  const note = signal.truncated ? '\n\n[Saved result truncated to 16 KiB.]' : '';
  const doc = await vscode.workspace.openTextDocument({ content: `${signal.provider} · ${signal.status}\nWindow: ${signal.windowInstanceId}\nSession: ${signal.sessionId}\nTurn: ${signal.turnId}\n\n${text || '[No final response body received]'}${note}${signal.detail ? '\n\n' + signal.detail : ''}`, language: 'plaintext' });
  await vscode.window.showTextDocument(doc, { preview: true });
}
