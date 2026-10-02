export type Provider = "codex" | "claude";
export type LogFormat = "runtime" | "transcript";
export interface Signal {
  provider: Provider;
  sessionId: string;
  turnId?: string;
  status: "completed" | "error" | "cancelled" | "responseObserved";
  proof: string;
  text: string;
  key: string;
}

// Runtime JSONL and persisted transcripts are deliberately separate adapters.
export class SignalParser {
  private sessionId: string;
  private lastText = "";
  private turnId?: string;
  private ordinal = 0;
  constructor(private provider: Provider, private format: LogFormat, sessionId = "unbound") {
    this.sessionId = sessionId;
  }
  parse(x: any, position: string): Signal | undefined {
    let status: Signal["status"] | undefined;
    let proof = "";
    let key = position;
    if (this.provider === "codex" && this.format === "runtime") {
      if (x.type === "thread.started") this.sessionId = x.thread_id;
      if (x.type === "turn.started") this.turnId = String(++this.ordinal);
      if (x.type === "item.completed" && x.item?.type === "agent_message") this.lastText = x.item.text;
      if (x.type === "turn.completed") { status = "completed"; proof = "turn.completed"; }
      if (x.type === "turn.failed" || x.type === "error") {
        status = "error"; proof = x.type; this.lastText = x.error?.message ?? x.message ?? "Codex error";
      }
    } else if (this.provider === "claude" && this.format === "runtime") {
      if (x.session_id) this.sessionId = x.session_id;
      if (x.type === "result") {
        status = x.subtype === "success" && x.is_error === false ? "completed" : "error";
        proof = `result/${x.subtype}`;
        this.lastText = x.result ?? x.errors?.join("\n") ?? "";
        key = x.uuid ?? position;
      }
    } else if (this.provider === "codex") {
      const p = x.payload;
      if (x.type === "session_meta") this.sessionId = p.id;
      if (x.type !== "event_msg") return;
      if (p?.type === "task_started") this.turnId = p.turn_id;
      if (p?.type === "task_complete" && p.turn_id) {
        status = "completed"; proof = "event_msg/task_complete";
        this.turnId = p.turn_id; this.lastText = p.last_agent_message ?? "";
        key = `${this.sessionId}:${p.turn_id}:complete`;
      }
      if (p?.type === "turn_aborted" && p.turn_id) {
        status = "cancelled"; proof = "event_msg/turn_aborted"; this.turnId = p.turn_id;
        key = `${this.sessionId}:${p.turn_id}:aborted`;
      }
    } else {
      if (x.sessionId) this.sessionId = x.sessionId;
      if (x.type !== "assistant" || x.isSidechain || x.isApiErrorMessage) return;
      const text = x.message?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      if (x.message?.stop_reason === "end_turn" && text) {
        // An API response ended. This does not prove hooks/background work finished.
        status = "responseObserved"; proof = "assistant/stop_reason=end_turn";
        this.lastText = text; key = x.message.id ?? x.uuid ?? position;
      }
    }
    if (!status) return;
    return { provider: this.provider, sessionId: this.sessionId, turnId: this.turnId,
      status, proof, text: this.lastText, key };
  }
}
