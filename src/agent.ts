import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { launchHostSession, switchModel, type HostSession } from "./host-session.js";
import { MODEL_CONFIG_ID, buildModelList, initialModelId, type ModelInfo } from "./models.js";
import type { ModEvent, TurnReason } from "./protocol.js";

interface PendingPrompt {
  resolve: (stopReason: acp.StopReason) => void;
  reject: (err: Error) => void;
}

interface Session {
  host: HostSession;
  pending: PendingPrompt[];
  models: ModelInfo[];
  currentModel: string;
  modelWaiters: Map<string, () => void>;
}

function modelOption(session: Pick<Session, "models" | "currentModel">): acp.SessionConfigOption {
  return {
    id: MODEL_CONFIG_ID,
    name: "Model",
    category: "model",
    type: "select",
    currentValue: session.currentModel,
    options: session.models.map((m) => ({ value: m.id, name: m.name, description: m.description })),
  };
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
    const env = process.env;
    const host = await launchHostSession({
      sessionId,
      cwd: params.cwd,
      env,
      onEvent: (event) => void this.onEvent(sessionId, event).catch(() => {}),
    });
    const session: Session = {
      host,
      pending: [],
      models: buildModelList(env),
      currentModel: initialModelId(env),
      modelWaiters: new Map(),
    };
    this.sessions.set(sessionId, session);
    return { sessionId, configOptions: [modelOption(session)] };
  }

  async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);
    if (params.configId !== MODEL_CONFIG_ID) throw new Error(`Unknown config option ${params.configId}`);
    const id = String(params.value);
    if (!session.models.some((m) => m.id === id)) throw new Error(`Unknown model ${id}`);
    if (id !== session.currentModel) {
      const changed = new Promise<void>((resolve) => session.modelWaiters.set(id, resolve));
      try {
        await switchModel(session.host, id, changed);
      } finally {
        session.modelWaiters.delete(id);
      }
    }
    return { configOptions: [modelOption(session)] };
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
    await Promise.all([...this.sessions.values()].map((s) => s.host.channel.close()));
    this.sessions.clear();
  }

  private async onEvent(sessionId: string, event: ModEvent): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (event.type === "chunk") {
      await this.conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } },
      });
    } else if (event.type === "model_changed" && session) {
      for (const resolve of session.modelWaiters.values()) resolve();
      if (event.id === session.currentModel) return;
      session.currentModel = event.id;
      if (!session.models.some((m) => m.id === event.id)) session.models.push({ id: event.id, name: event.id });
      await this.conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: [modelOption(session)] },
      });
    } else if (event.type === "turn_completed" && session) {
      const next = session.pending.shift();
      const stopReason = STOP_REASONS[event.reason];
      if (stopReason) next?.resolve(stopReason);
      else next?.reject(new Error(`Turn ended with ${event.reason}`));
    }
  }
}
