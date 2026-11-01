// VS Code 대화상자로 작업·작업 폴더·제공자 입력 요청을 받는다.
import * as vscode from 'vscode';
import type { ApplicationSession } from '../application/sessions';
import type { InputRequest } from '../core/model';
import type { AgentInteraction, QuestionOptions } from '../runtime/agent-provider';
import { agentProviders } from '../runtime/providers';

/** 작업·폴더·승인·질문을 VS Code 입력 대화상자로 제공한다. */
export class AgentInput implements AgentInteraction {
  async prompt(): Promise<string | undefined> {
    return vscode.window.showInputBox({ title: 'Job-Finish · Agent task', prompt: 'Run in this workspace. Tool approvals will appear in Answer Pending Request.', ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : 'Enter a task' });
  }

  async cwd(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length === 1) return folders[0]!.uri.fsPath;
    if (folders?.length) return (await vscode.window.showWorkspaceFolderPick())?.uri.fsPath;
    return (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Agent working directory' }))?.[0]?.fsPath;
  }

  answer(entry: ApplicationSession, request: InputRequest): Promise<unknown> {
    return agentProviders.get(entry.provider).answer(request, this);
  }

  async showRequest(payload: unknown): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content: JSON.stringify(payload, null, 2), language: 'json' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  async approve(title: string): Promise<boolean | undefined> {
    const answer = await vscode.window.showQuickPick(['Deny', 'Allow once'], { title, ignoreFocusOut: true });
    return answer === undefined ? undefined : answer === 'Allow once';
  }

  async question(question: string, options: { label: string; description?: string }[],
    { multiSelect, secret }: QuestionOptions): Promise<string[] | undefined> {
    if (options.length && !secret) {
      const custom = { label: 'Write an answer…', description: '' };
      const picks = await vscode.window.showQuickPick([...options, custom], { title: question, canPickMany: multiSelect, ignoreFocusOut: true });
      if (!picks) return;
      const list = Array.isArray(picks) ? picks : [picks];
      if (!list.some(item => item === custom)) return list.map(item => item.label);
    }
    const text = await vscode.window.showInputBox({ title: question, password: secret, ignoreFocusOut: true });
    return text === undefined ? undefined : [text];
  }
}
