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
  | { type: "chunk"; kind: "text"; text: string }
  | { type: "turn_completed"; reason: TurnReason }
  | { type: "mode"; mode: string };

export const POLL_WINDOW_MS = 20_000;
