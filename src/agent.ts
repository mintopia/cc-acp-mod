import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { launchHostSession, switchModel, type HostSession } from "./host-session.js";
import { MODEL_CONFIG_ID, buildModelList, initialModelId, type ModelInfo } from "./models.js";
import { TaskPlan, planEntries, toolInfo } from "./tool-mapping.js";
import type { ModEvent, TurnReason } from "./protocol.js";

export interface UpdateSink {
  sessionUpdate(params: acp.SessionNotification): Promise<void>;
}

export type HostLauncher = (opts: {
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onEvent: (event: ModEvent) => void;
}) => Promise<Pick<HostSession, "sessionId"> & { channel: Pick<HostSession["channel"], "send" | "close"> }>;

interface QueuedPrompt {
  text: string;
  resolve: (stopReason: acp.StopReason) => void;
  reject: (err: Error) => void;
  cancelRequested: boolean;
}

interface Session {
  host: Awaited<ReturnType<HostLauncher>>;
  queue: QueuedPrompt[];
  taskPlan: TaskPlan;
  tools: Map<string, { tool: string; input: Record<string, unknown> }>;
  current?: QueuedPrompt;
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

export class CcAcpAgent {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly client: UpdateSink,
    private readonly version: string,
    private readonly launch: HostLauncher = launchHostSession,
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
    let events: Promise<void> = Promise.resolve();
    const host = await this.launch({
      sessionId,
      cwd: params.cwd,
      env,
      onEvent: (event) => {
        events = events.then(() => this.onEvent(sessionId, event)).catch(() => {});
      },
    });
    const session: Session = {
      host,
      queue: [],
      taskPlan: new TaskPlan(),
      tools: new Map(),
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

  async prompt(params: acp.PromptRequest, signal?: AbortSignal): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    const stopReason = await new Promise<acp.StopReason>((resolve, reject) => {
      const entry: QueuedPrompt = { text, resolve, reject, cancelRequested: false };
      session.queue.push(entry);
      signal?.addEventListener("abort", () => this.cancelPrompt(session, entry), { once: true });
      this.startNext(session);
    });
    return { stopReason };
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session?.current) this.cancelPrompt(session, session.current);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.host.channel.close()));
    this.sessions.clear();
  }

  private startNext(session: Session): void {
    if (session.current) return;
    const next = session.queue.shift();
    if (!next) return;
    session.current = next;
    session.host.channel.send({ type: "prompt", text: next.text });
  }

  private cancelPrompt(session: Session, entry: QueuedPrompt): void {
    if (entry === session.current) {
      if (entry.cancelRequested) return;
      entry.cancelRequested = true;
      session.host.channel.send({ type: "cancel" });
      return;
    }
    const index = session.queue.indexOf(entry);
    if (index === -1) return;
    session.queue.splice(index, 1);
    entry.resolve("cancelled");
  }

  private async onEvent(sessionId: string, event: ModEvent): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (event.type === "chunk") {
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: event.kind === "thinking" ? "agent_thought_chunk" : "agent_message_chunk",
          content: { type: "text", text: event.text },
        },
      });
    } else if (event.type === "model_changed" && session) {
      for (const resolve of session.modelWaiters.values()) resolve();
      if (event.id === session.currentModel) return;
      session.currentModel = event.id;
      if (!session.models.some((m) => m.id === event.id)) session.models.push({ id: event.id, name: event.id });
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: [modelOption(session)] },
      });
    } else if (event.type === "tool_started") {
      session?.tools.set(event.toolUseId, { tool: event.tool, input: event.input });
      const info = toolInfo(event.tool, event.input);
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: event.toolUseId,
          status: "pending",
          rawInput: event.input,
          _meta: { claudeCode: { toolName: event.tool } },
          ...info,
        },
      });
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: event.toolUseId, status: "in_progress" },
      });
      const entries = planEntries(event.tool, event.input);
      if (entries) await this.client.sessionUpdate({ sessionId, update: { sessionUpdate: "plan", entries } });
    } else if (event.type === "tool_finished") {
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolUseId,
          status: event.isError ? "failed" : "completed",
        },
      });
      const started = session?.tools.get(event.toolUseId);
      session?.tools.delete(event.toolUseId);
      const entries = started && !event.isError ? session?.taskPlan.apply(started.tool, started.input, event.result) : undefined;
      if (entries) await this.client.sessionUpdate({ sessionId, update: { sessionUpdate: "plan", entries } });
    } else if (event.type === "turn_completed" && session?.current) {
      const done = session.current;
      session.current = undefined;
      const stopReason = done.cancelRequested && event.reason !== "error" ? "cancelled" : STOP_REASONS[event.reason];
      if (stopReason) done.resolve(stopReason);
      else done.reject(new Error(`Turn ended with ${event.reason}`));
      this.startNext(session);
    }
  }
}
