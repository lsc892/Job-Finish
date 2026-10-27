// 현재 VS Code 창의 네이티브 식별·포커스 관찰·작업표시줄 깜박임을 연결한다.
import * as vscode from 'vscode';
import { Diagnostics } from '../core/model';
import { Win32, WindowIdentity } from '../windows/native';
import { FlashController } from '../windows/flash';

/** 한 VS Code 창의 네이티브 식별·포커스 관찰·깜박임 수명을 관리한다. */
export class CodeWindow {
  private native?: Win32;
  private identity?: WindowIdentity;
  private flash?: FlashController;

  constructor(readonly windowInstanceId: string, private readonly diagnostics: Diagnostics) {
    try {
      this.native = new Win32();
      this.identity = new WindowIdentity(windowInstanceId, this.native, () => vscode.window.state.focused, process.execPath, diagnostics);
      this.flash = new FlashController(this.native, () => vscode.window.state.focused);
    } catch (error) { diagnostics.add(`Native flash unavailable: ${error}`); }
  }

  get binding() { return this.identity?.binding; }
  get flashId(): string | undefined { return this.flash?.activeNotificationId; }
  valid() { return this.identity?.valid(); }
  observe(delay?: number): Promise<boolean> | undefined { return this.identity?.observe(delay); }
  unbind(): void { if (this.identity) this.identity.binding = undefined; }

  startFlash(notificationId: string, mode: 'manual' | 'system', timeoutMs: number): void {
    const binding = this.valid();
    if (binding) this.flash?.start(binding, notificationId, mode, timeoutMs);
  }

  stopFlash(id?: string): void { this.flash?.stop(id); }

  watchFocus(): vscode.Disposable {
    return vscode.window.onDidChangeWindowState(state => {
      this.diagnostics.trace('window.focus', { windowInstanceId: this.windowInstanceId, focused: state.focused, foreground: this.native?.foreground().toString() });
      this.identity?.changed();
      if (state.focused) {
        this.stopFlash();
        void this.observe()?.catch(error => this.diagnostics.add(error));
      }
    });
  }

  async bind(): Promise<void> {
    if (!await this.observe()) throw new Error('Could not verify a stable focused Code window. Focus this window and retry.');
    void vscode.window.showInformationMessage(`Job-Finish: window ${this.windowInstanceId.slice(0, 8)} connected.`);
  }

  dispose(): void {
    this.flash?.dispose();
    this.identity?.dispose();
  }
}
