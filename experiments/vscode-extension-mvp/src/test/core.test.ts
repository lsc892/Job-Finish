import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JsonlTail } from "../tail";
import { SignalParser } from "../signals";
import { claimLog } from "../ownership";

test("tail buffers split UTF-8/JSON, skips history, and recovers from truncation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jf-tail-"));
  try {
    const filename = path.join(root, "session.jsonl");
    await writeFile(filename, '{"old":true}\n');
    const seen: unknown[] = [], errors: unknown[] = [];
    const tail = new JsonlTail(filename, record => seen.push(record), error => errors.push(error));
    await tail.initialize();
    await tail.drain();
    assert.deepEqual(seen, []);
    const bytes = Buffer.from('{"text":"완료"}\n');
    const split = bytes.indexOf(Buffer.from("완")) + 1;
    await appendFile(filename, bytes.subarray(0, split)); await tail.drain();
    assert.deepEqual(seen, []);
    await appendFile(filename, bytes.subarray(split)); await tail.drain();
    assert.deepEqual(seen, [{ text: "완료" }]);
    await writeFile(filename, '{"new":1}\n'); await tail.drain();
    assert.deepEqual(seen, [{ text: "완료" }, { new: 1 }]);
    assert.deepEqual(errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("a partial historical row is not replayed on binding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jf-baseline-"));
  try {
    const filename = path.join(root, "session.jsonl");
    await writeFile(filename, '{"old":');
    const seen: unknown[] = [], errors: unknown[] = [];
    const tail = new JsonlTail(filename, x => seen.push(x), e => errors.push(e));
    await tail.initialize();
    await appendFile(filename, 'true}\n{"live":true}\n'); await tail.drain();
    assert.deepEqual(seen, [{ live: true }]); assert.deepEqual(errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("Claude runtime failures and transcript end_turn have distinct meanings", () => {
  const runtime = new SignalParser("claude", "runtime");
  assert.equal(runtime.parse({ type: "result", subtype: "success", is_error: true }, "1")?.status, "error");
  assert.equal(runtime.parse({ type: "result", subtype: "error_max_turns", is_error: false }, "2")?.status, "error");
  assert.equal(runtime.parse({ type: "result", subtype: "success", is_error: false }, "3")?.status, "completed");
  const transcript = new SignalParser("claude", "transcript");
  const row = { type: "assistant", sessionId: "s", message: { id: "m", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } };
  assert.equal(transcript.parse(row, "1")?.status, "responseObserved");
  assert.equal(transcript.parse({ ...row, isSidechain: true }, "2"), undefined);
  assert.equal(transcript.parse({ ...row, isApiErrorMessage: true }, "3"), undefined);
  assert.equal(transcript.parse({ ...row, message: { ...row.message, stop_reason: "tool_use" } }, "4"), undefined);
});
test("Codex final text alone is not completion; turn IDs key native signals", () => {
  const parser = new SignalParser("codex", "transcript", "s");
  assert.equal(parser.parse({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "done" } }, "1"), undefined);
  const row = { type: "event_msg", payload: { type: "task_complete", turn_id: "t", last_agent_message: "done" } };
  assert.equal(parser.parse(row, "2")?.key, parser.parse(row, "3")?.key);
  assert.equal(parser.parse({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "t" } }, "4")?.status, "cancelled");
});
test("concurrent ownership admits exactly one window and releases normally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jf-owner-"));
  try {
    const file = path.join(root, "session.jsonl");
    const attempts = await Promise.allSettled([claimLog(root, file, "A"), claimLog(root, file, "B")]);
    assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
    const winner = attempts.find(x => x.status === "fulfilled");
    if (winner?.status === "fulfilled") await winner.value();
    await (await claimLog(root, file, "C"))();
  } finally { await rm(root, { recursive: true, force: true }); }
});
