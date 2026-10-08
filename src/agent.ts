import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { launchHostSession, stopHostSession, type HostSession } from "./host-session.js";
import type { ModEvent, TurnReason } from "./protocol.js";

interface PendingPrompt {
  resolve: (stopReason: acp.StopReason) => void;
  reject: (err: Error) => void;
}

interface Session {
  host: HostSession;
  pending: PendingPrompt[];
}

const STOP_REASONS: Partial<Record<TurnReason, acp.StopReason>> = {
  answer: "end_turn",
  aborted: "cancelled",
  refusal: "refusal",
};

export class CcAcpAgent implements acp.Agent {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly conn: acp.AgentSideConnection,
    private readonly version: string,
  ) {}

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "cc-acp", title: "Claude Code (cc-acp)", version: this.version },
      agentCapabilities: {},
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    const host = await launchHostSession({
      sessionId,
      cwd: params.cwd,
      onEvent: (event) => void this.onEvent(sessionId, event).catch(() => {}),
    });
    this.sessions.set(sessionId, { host, pending: [] });
    return { sessionId };
  }

  async authenticate(): Promise<void> {}

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    const stopReason = await new Promise<acp.StopReason>((resolve, reject) => {
      session.pending.push({ resolve, reject });
      session.host.channel.send({ type: "prompt", text });
    });
    return { stopReason };
  }

  async cancel(): Promise<void> {}

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => stopHostSession(s.host)));
    this.sessions.clear();
  }

  private async onEvent(sessionId: string, event: ModEvent): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (event.type === "chunk") {
      await this.conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } },
      });
    } else if (event.type === "turn_completed" && session) {
      const next = session.pending.shift();
      const stopReason = STOP_REASONS[event.reason];
      if (stopReason) next?.resolve(stopReason);
      else next?.reject(new Error(`Turn ended with ${event.reason}`));
    }
  }
}
