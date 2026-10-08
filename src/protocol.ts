import type { AskQuestion } from "./ask-user-question.js";

export const PROTOCOL_VERSION = 1;

export interface Hello {
  protocolVersion: number;
  sessionId: string;
  modVersion: string;
  steering?: boolean;
  buffered?: number;
}

export type Command =
  | { type: "prompt"; text: string }
  | { type: "cancel" }
  | { type: "steer"; text: string }
  | { type: "set_model"; id: string }
  | { type: "set_effort"; value: string }
  | { type: "set_fast"; value: string }
  | { type: "question_answer"; requestId: string; answers: Record<string, string> | null };

export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  terminalOnly?: boolean;
}

export type PermissionDecision = "allow_once" | "allow_with_updates" | "reject";

export type TurnReason = "answer" | "aborted" | "refusal" | "error";

export type ModEvent =
  | { type: "turn_started"; turnId: string }
  | { type: "chunk"; kind: "text" | "thinking"; text: string }
  | { type: "tool_started"; toolUseId: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_finished"; toolUseId: string; isError: boolean; result?: unknown }
  | { type: "turn_completed"; reason: TurnReason }
  | { type: "model_changed"; id: string }
  | { type: "config_changed"; option: "effort" | "fast"; value: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedReadTokens?: number; cachedWriteTokens?: number; contextUsed: number; contextSize: number }
  | { type: "title"; title: string }
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "ask_question"; requestId: string; questions: AskQuestion[] }
  | {
      type: "permission_request";
      requestId: string;
      tool: string;
      input: Record<string, unknown>;
      toolUseId?: string;
      suggestions?: unknown[];
    };

export const POLL_WINDOW_MS = 20_000;
