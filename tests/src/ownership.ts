import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export async function claimLog(root: string, logPath: string, windowInstanceId: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true });
  const canonical = process.platform === "win32" ? path.resolve(logPath).toLowerCase() : path.resolve(logPath);
  const filename = path.join(root, `${createHash("sha256").update(canonical).digest("hex")}.lock`);
  const token = randomUUID();
  let file;
  try { file = await open(filename, "wx"); }
  catch (error: any) {
    if (error.code === "EEXIST") throw new Error("Session log is already owned by another window (or an unreleased MVP lock).");
    throw error;
  }
  try { await file.writeFile(JSON.stringify({ token, windowInstanceId, logPath })); }
  finally { await file.close(); }
  return async () => {
    try {
      const owner = JSON.parse(await readFile(filename, "utf8"));
      if (owner.token === token) await unlink(filename);
    } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  };
}
