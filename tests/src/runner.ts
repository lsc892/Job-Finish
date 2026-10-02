import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Provider } from "./signals";

async function findExecutable(directory: string, name: string): Promise<string | undefined> {
  if (!existsSync(directory)) return;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isFile() && item.name === name) return filename;
    if (item.isDirectory()) { const found = await findExecutable(filename, name); if (found) return found; }
  }
}
export async function resolveExecutable(provider: Provider, configured?: string): Promise<string> {
  if (configured) {
    if (!path.isAbsolute(configured) || !existsSync(configured)) throw new Error("Executable must be an existing absolute path.");
    if (process.platform === "win32" && !configured.toLowerCase().endsWith(".exe")) throw new Error("Use the native .exe, not a .cmd/.ps1 wrapper.");
    return configured;
  }
  const name = provider + (process.platform === "win32" ? ".exe" : "");
  for (const directory of [path.join(os.homedir(), ".local", "bin"), ...(process.env.PATH ?? "").split(path.delimiter)]) {
    const filename = path.join(directory, name);
    if (existsSync(filename)) return filename;
  }
  if (provider === "codex" && process.platform === "win32") {
    const npmRoot = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai");
    const found = await findExecutable(npmRoot, name);
    if (found) return found;
  }
  throw new Error(`Cannot find ${provider}; configure jobFinishMvp.${provider}Executable.`);
}

export interface RunRequest {
  provider: Provider;
  executable: string;
  cwd: string;
  journal: string;
  prompt: string;
  sessionId: string;
  resume?: boolean;
  timeoutMs?: number;
}
export function launchProbe(request: RunRequest): { done: Promise<{ exitCode: number | null; timedOut: boolean }>; cancel: () => void } {
  const args = request.provider === "codex"
    ? ["exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only",
      "-c", 'approval_policy="never"', "--cd", request.cwd, ...(request.resume ? ["resume", request.sessionId, "-"] : ["-"])]
    : ["--print", "--output-format", "stream-json", "--verbose", request.resume ? "--resume" : "--session-id", request.sessionId,
      "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--settings", '{"disableAllHooks":true}', "--permission-mode", "dontAsk"];
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  const child = spawn(request.executable, args, { cwd: request.cwd, env, windowsHide: true, shell: false });
  let writes: Promise<void> = Promise.resolve();
  let writeError: unknown;
  let timedOut = false;
  let stderr = "";
  let spawnError: unknown;
  const cancel = () => {
    if (child.exitCode !== null || !child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => child.kill());
    } else { child.kill("SIGTERM"); }
  };
  const timeout = setTimeout(() => { timedOut = true; cancel(); }, request.timeoutMs ?? 120_000);
  child.stdout.on("data", (chunk: Buffer) => {
    writes = writes.then(() => appendFile(request.journal, chunk)).catch(error => { writeError = error; cancel(); });
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
  child.on("error", error => { spawnError = error; });
  child.stdin.on("error", () => { /* The close/error handler reports an early process exit. */ });
  child.stdin.end(request.prompt + "\n");
  const done = new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
    child.on("close", async exitCode => {
      clearTimeout(timeout);
      await writes;
      if (spawnError || writeError) { reject(spawnError ?? writeError); return; }
      // No stderr is exposed on success: it can contain configuration/account details.
      if (timedOut) { reject(new Error("Agent probe timed out; its owned process was stopped.")); return; }
      if (exitCode !== 0 && !(await stat(request.journal)).size) {
        reject(new Error(`${request.provider} exited with ${exitCode}: ${stderr}`)); return;
      }
      resolve({ exitCode, timedOut });
    });
  });
  return { done, cancel };
}
