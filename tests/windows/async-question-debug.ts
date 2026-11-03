// 제어한 실제 stdio 프로세스와 Windows 토스트로 비동기 질문의 재알림 여부를 기록한다.
// 실행: npx tsx tests/windows/async-question-debug.ts --scenario late|early --activate-hwnd <HWND> [--helper <EXE>]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Diagnostics, Signal } from '../../src/core/model';
import { notificationTitle, Notifications } from '../../src/core/notifications';
import { AgentStreamObserver } from '../../src/runtime/observe';
import { WindowsToast } from '../../src/windows/toast';
import { toastImagePath } from '../../src/windows/toast/image';
import { Win32 } from '../../src/windows/native';

async function main(): Promise<void> {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const scenario = argument('--scenario');
  assert.ok(scenario === 'late' || scenario === 'early', '--scenario must be late or early');
  const hwnd = argument('--activate-hwnd');
  assert.ok(hwnd && /^(?:[0-9]+|0x[0-9a-f]+)$/i.test(hwnd), '--activate-hwnd must identify the explicit diagnostic target');
  const native = new Win32();
  const target = native.inspect(BigInt(hwnd));
  assert.ok(target, 'The explicit target must be an existing visible window');
  const root = resolve('test-artifacts/async-question-debug', `${Date.now()}-${scenario}`);
  mkdirSync(root, { recursive: true });
  const started = performance.now();
  const events: Record<string, unknown>[] = [];
  function log(event: string, fields: Record<string, unknown> = {}): void {
    const entry = { ...fields, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), event };
    events.push(entry);
    appendFileSync(join(root, 'events.jsonl'), JSON.stringify(entry) + '\n');
    console.log(JSON.stringify(entry));
  }
  const diagnostics = new Diagnostics(entry => log(entry.event, entry));
  const windowInstanceId = randomUUID();
  const executable = process.env.JOB_FINISH_CODE_EXECUTABLE
    ?? join(process.env.LOCALAPPDATA!, 'Programs/Microsoft VS Code/Code.exe');
  assert.equal(resolve(target.executable).toLowerCase(), resolve(executable).toLowerCase(), 'The target must belong to this VS Code executable');
  const toast = new WindowsToast(argument('--helper') ?? WindowsToast.binary(resolve('.')), diagnostics, undefined, executable);
  const signals: Signal[] = [];
  const errors: string[] = [];
  const deliveries = new Set<Promise<void>>();
  let observer: AgentStreamObserver;
  let toastCalls = 0;
  const notifications = new Notifications({
    // 이 독립 실행기는 VS Code 창의 포커스 대신 명시적으로 백그라운드 조건을 재현한다.
    focused: () => false, enabled: () => true, owns: signal => observer.owns(signal),
    stopFlash: () => {}, activate: signal => log('click.handled', { notificationId: signal.notificationId, foreground: native.foreground().toString() }),
    flash: signal => log('flash.requested', { notificationId: signal.notificationId, nativeFlashEnabled: false }),
    toast: async (signal, message, click, allowed) => {
      toastCalls++;
      log('toast.call', { notificationId: signal.notificationId, status: signal.status, text: signal.text, toastCalls });
      await toast.show({ notificationId: signal.notificationId, windowInstanceId, appId: WindowsToast.appId,
        title: `${notificationTitle(signal)} · DEBUG ${scenario}`, message,
        target: { hwnd: target.hwnd.toString(), pid: target.pid, executable: target.executable },
        canActivate: () => observer.owns(signal),
        imagePath: toastImagePath(resolve('.'), true), onClick: click }, allowed);
      log('toast.delivery.finished', { notificationId: signal.notificationId });
    },
  });
  observer = new AgentStreamObserver(windowInstanceId,
    () => [{ provider: 'codex', path: resolve('tests/fixtures') }], signal => {
      signals.push(signal);
      log('signal.received', { signal });
      const delivery = notifications.deliver(signal).catch(error => {
        errors.push(String(error)); log('delivery.error', { error: String(error) });
      });
      deliveries.add(delivery);
      void delivery.finally(() => deliveries.delete(delivery));
    }, diagnostics);
  observer.start();
  const child = spawn(process.execPath, [resolve('tests/fixtures/observed-agent.cjs'), 'app-server'],
    { windowsHide: true, stdio: 'pipe' });
  child.on('error', error => errors.push(String(error)));
  const received: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    received.push(chunk);
    appendFileSync(join(root, 'stdout.jsonl'), chunk);
    log('source.stdout', { text: chunk.toString('utf8') });
  });
  const sent: unknown[] = [];
  function send(...messages: unknown[]): void {
    for (const message of messages) { sent.push(message); log('source.send', { message }); }
    child.stdin.write(JSON.stringify({ events: messages }) + '\n');
  }
  async function until(predicate: () => boolean): Promise<void> {
    const deadline = performance.now() + 12_000;
    while (!predicate()) {
      assert.ok(performance.now() < deadline, 'Timed out waiting for an observed event');
      assert.deepEqual(errors, []);
      await pause(25);
    }
  }
  const submitted = () => events.filter(event => event.event === 'toast.submitted').length;
  const question = { method: 'item/started', params: { threadId: 'debug-thread', turnId: 'debug-turn',
    item: { type: 'agentMessage', id: 'same-question', phase: 'commentary', delivery: 'async', text: '',
      questions: [{ title: `[DEBUG ${scenario}] 어느 환경인가요? AI는 계속 작업 중입니다.`, options: null }] } } };
  let passed = false;
  try {
    log('debug.ready', { root, scenario, source: 'controlled-stdio-fixture', backgroundForced: true,
      nativeToastEnabled: true, nativeFlashEnabled: false,
      target: { ...target, hwnd: target.hwnd.toString() }, foreground: native.foreground().toString() });
    assert.equal(observer.snapshot().connections.length, 1);
    await toast.initialize();
    send({ method: 'turn/started', params: { threadId: 'debug-thread', turn: { id: 'debug-turn', status: 'inProgress', items: [] } } }, question);
    await until(() => signals.length === 1 && submitted() === 1);
    const questionAt = performance.now();
    log('question.submitted', { submitted: submitted(), toastCalls });
    if (scenario === 'late') {
      for (const seconds of [5, 10, 15]) {
        await pause(Math.max(0, questionAt + seconds * 1000 - performance.now()));
        log('checkpoint.before-replay', { seconds, signals: signals.length, toastCalls, submitted: submitted(), observer: observer.snapshot() });
        assert.equal(signals.length, 1, 'Elapsed time alone must not generate a signal');
        assert.equal(toastCalls, 1, 'Elapsed time alone must not call toast.show');
        send(question, { ...question, method: 'item/completed' },
          { method: 'item/completed', params: { threadId: 'debug-thread', turnId: 'debug-turn',
            item: { type: 'agentMessage', id: `work-${seconds}`, phase: 'commentary', text: `Still working at ${seconds}s`, questions: null } } });
        const expectedBytes = sent.map(message => JSON.stringify(message) + '\n').join('');
        await until(() => Buffer.concat(received).toString('utf8') === expectedBytes);
        assert.equal(signals.length, 1, 'Replayed start/completion for the same question must deduplicate');
        assert.equal(toastCalls, 1);
        assert.equal(submitted(), 1);
        log('checkpoint.after-replay', { seconds, signals: signals.length, toastCalls, submitted: submitted() });
      }
      await pause(1000);
    } else {
      await pause(Math.max(0, questionAt + 3000 - performance.now()));
    }
    log('completion.send', { questionAgeMs: Math.round(performance.now() - questionAt), submittedBefore: submitted() });
    send({ method: 'turn/completed', params: { threadId: 'debug-thread', turn: { id: 'debug-turn', status: 'completed',
      items: [question.params.item, { type: 'agentMessage', id: 'final', phase: 'final_answer',
        text: `[DEBUG ${scenario}] 실제 턴 완료 이벤트를 보냈습니다.`, questions: null }] } } });
    await until(() => signals.length === 2);
    await Promise.all([...deliveries]);
    await pause(6000);
    const expectedToasts = scenario === 'late' ? 2 : 1;
    assert.equal(toastCalls, expectedToasts);
    assert.equal(submitted(), expectedToasts);
    assert.deepEqual(signals.map(signal => signal.status), ['waitingForInput', 'completed']);
    assert.deepEqual(notifications.results.map(signal => signal.status), ['waitingForInput', 'completed']);
    assert.equal(observer.snapshot().connections[0]!.activeTurns, 0);
    assert.equal(Buffer.concat(received).toString('utf8'), sent.map(message => JSON.stringify(message) + '\n').join(''));
    assert.deepEqual(errors, []);
    assert.deepEqual(diagnostics.entries, []);
    passed = true;
    log('debug.passed', { scenario, signals: signals.length, toastCalls, submitted: submitted(), afterCompletionQuietMs: 6000 });
  } catch (error) {
    errors.push(String(error)); log('debug.failed', { error: String(error) });
    process.exitCode = 1;
  } finally {
    writeFileSync(join(root, 'summary.json'), JSON.stringify({ passed, scenario, source: 'controlled-stdio-fixture',
      nativeToastEnabled: true, backgroundForced: true, nativeFlashEnabled: false, visualAppearanceVerified: false,
      target: { ...target, hwnd: target.hwnd.toString() },
      activationResults: events.filter(event => event.event === 'window.activation.result'),
      toastCalls, submitted: submitted(), signals, errors, diagnostics: diagnostics.entries, events }, null, 2));
    observer.dispose(); child.kill(); toast.dispose();
    console.log(`Debug artifacts: ${root}`);
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
