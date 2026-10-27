import * as vscode from 'vscode';
import type { Signal } from '../core/model';
import type { ApplicationSessions } from '../application/sessions';

/** Displays a stored result and attempts full-text retrieval only when its preview was truncated. */
export async function showResults(results: readonly Signal[], sessions: Pick<ApplicationSessions, 'get'>): Promise<void> {
  const signals = [...results].reverse();
  const choice = await vscode.window.showQuickPick(signals.map(signal => ({ label: `${signal.provider} · ${signal.status}`, description: `${signal.at} · ${signal.sessionId}`, detail: signal.text.slice(0, 120), value: signal })), { title: 'Recent results (up to 20)' });
  if (!choice) return;
  const signal = choice.value;
  let text = signal.text;
  let note = '';
  if (signal.truncated) {
    try {
      const full = await sessions.get(signal.sessionId)?.execution.readResult(signal.turnId);
      if (full) text = full;
      else note = '\n\n[Saved result truncated to 16 KiB; full result unavailable.]';
    } catch (error) {
      note = `\n\n[Saved result truncated; full result retrieval failed: ${error}]`;
    }
  }
  const doc = await vscode.workspace.openTextDocument({ content: `${signal.provider} · ${signal.status}\nWindow: ${signal.windowInstanceId}\nSession: ${signal.sessionId}\nTurn: ${signal.turnId}\n\n${text || '[No final response body received]'}${note}${signal.detail ? '\n\n' + signal.detail : ''}`, language: 'plaintext' });
  await vscode.window.showTextDocument(doc, { preview: true });
}
