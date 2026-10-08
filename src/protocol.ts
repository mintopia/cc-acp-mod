export const PROTOCOL_VERSION = 1;

export interface Hello {
  protocolVersion: number;
  sessionId: string;
  modVersion: string;
}

export type Command = { type: "prompt"; text: string } | { type: "cancel" };

export type TurnReason = "answer" | "aborted" | "refusal" | "error";

export type ModEvent =
  | { type: "turn_started"; turnId: string }
  | { type: "chunk"; kind: "text" | "thinking"; text: string }
  | { type: "tool_started"; toolUseId: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_finished"; toolUseId: string; isError: boolean }
  | { type: "turn_completed"; reason: TurnReason };

export const POLL_WINDOW_MS = 20_000;
