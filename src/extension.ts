// 로컬 Windows VS Code에서 확장을 활성화하고 애플리케이션 수명을 연결한다.
import * as vscode from 'vscode';
import { Application } from './vscode/application';

let active: Application | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  if (process.platform !== 'win32' || vscode.env.remoteName) {
    const output = vscode.window.createOutputChannel('Job-Finish');
    context.subscriptions.push(output);
    output.appendLine('Job-Finish requires a local Windows desktop VS Code window.');
    return;
  }
  active = new Application(context);
  await active.activate();
  return active.api;
}

export function deactivate(): void {
  active?.dispose();
  active = undefined;
}
