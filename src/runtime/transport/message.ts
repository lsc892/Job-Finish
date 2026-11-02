// JSON-RPC 메시지의 공통 타입과 응답 오류를 정의한다.
export type RpcId = string | number;
export interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** RPC 응답의 오류 코드와 메시지를 호출자에게 전달한다. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
