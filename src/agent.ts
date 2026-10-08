import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { formAnswers, questionForm } from "./ask-user-question.js";
import { launchHostSession, switchModel, type HostSession } from "./host-session.js";
import { MODEL_CONFIG_ID, buildModelList, initialModelId, type ModelInfo } from "./models.js";
import { TaskPlan, bashOutput, diffContent, planEntries, toolInfo } from "./tool-mapping.js";
import type { ModEvent, TurnReason } from "./protocol.js";

export interface UpdateSink {
  sessionUpdate(params: acp.SessionNotification): Promise<void>;
  createElicitation?(params: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse>;
}

export type HostLauncher = (opts: {
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  disallowedTools?: string[];
  onEvent: (event: ModEvent) => void;
}) => Promise<Pick<HostSession, "sessionId"> & { steering?: boolean; channel: Pick<HostSession["channel"], "send" | "close"> }>;

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
  effort: string;
  fast: string;
  configWaiters: Map<string, () => void>;
}

export const EFFORT_CONFIG_ID = "effort";
export const FAST_CONFIG_ID = "fast";
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const FAST_VALUES = ["off", "on"];
const SET_CONFIG_TIMEOUT_MS = 30_000;

function configOptions(session: Session): acp.SessionConfigOption[] {
  return [
    modelOption(session),
    {
      id: EFFORT_CONFIG_ID,
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: session.effort,
      options: EFFORT_LEVELS.map((v) => ({ value: v, name: v })),
    },
    {
      id: FAST_CONFIG_ID,
      name: "Fast mode",
      type: "select",
      currentValue: session.fast,
      options: FAST_VALUES.map((v) => ({ value: v, name: v })),
    },
  ];
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
  private formElicitation = false;
  private terminalOutput = false;

  constructor(
    private readonly client: UpdateSink,
    private readonly version: string,
    private readonly launch: HostLauncher = launchHostSession,
  ) {}

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    this.terminalOutput = (params.clientCapabilities?._meta as Record<string, unknown> | undefined)?.terminal_output === true;
    this.formElicitation = params.clientCapabilities?.elicitation?.form != null && this.client.createElicitation !== undefined;
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
      disallowedTools: this.formElicitation ? [] : ["AskUserQuestion"],
      onEvent: (event) => {
        if (event.type === "ask_question") return void this.askQuestion(sessionId, event);
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
      effort: "high",
      fast: "off",
      configWaiters: new Map(),
    };
    this.sessions.set(sessionId, session);
    return { sessionId, configOptions: configOptions(session), _meta: { steering: { supported: host.steering === true } } };
  }

  async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);
    if (params.configId === EFFORT_CONFIG_ID || params.configId === FAST_CONFIG_ID) {
      await this.setEffortOrFast(session, params.configId, String(params.value));
      return { configOptions: configOptions(session) };
    }
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
    return { configOptions: configOptions(session) };
  }

  private async setEffortOrFast(session: Session, option: "effort" | "fast", value: string): Promise<void> {
    const allowed = option === "effort" ? EFFORT_LEVELS : FAST_VALUES;
    if (!allowed.includes(value)) throw new Error(`Unknown ${option} value ${value}`);
    if (value === session[option]) return;
    const key = `${option}:${value}`;
    let timer: NodeJS.Timeout | undefined;
    const applied = new Promise<void>((resolve, reject) => {
      session.configWaiters.set(key, resolve);
      timer = setTimeout(() => reject(new Error(`${option} did not change to ${value}`)), SET_CONFIG_TIMEOUT_MS);
    });
    try {
      session.host.channel.send(option === "effort" ? { type: "set_effort", value } : { type: "set_fast", value });
      await applied;
    } finally {
      clearTimeout(timer);
      session.configWaiters.delete(key);
    }
  }

  async steer(params: { sessionId: string; prompt: acp.ContentBlock[] }): Promise<Record<string, never>> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);
    if (!session.host.steering) throw acp.RequestError.methodNotFound("_session/steering");
    if (!session.current) throw new Error("No running turn to steer");
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    session.host.channel.send({ type: "steer", text });
    return {};
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

  private async askQuestion(sessionId: string, event: Extract<ModEvent, { type: "ask_question" }>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    let answers: Record<string, string> | null = null;
    if (this.formElicitation) {
      try {
        const res = await this.client.createElicitation!({
          mode: "form",
          sessionId,
          message: "Claude has a question",
          requestedSchema: questionForm(event.questions),
        });
        if (res.action === "accept") answers = formAnswers(event.questions, res.content as Record<string, unknown> | null | undefined);
      } catch {}
    }
    session.host.channel.send({ type: "question_answer", requestId: event.requestId, answers });
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
        update: { sessionUpdate: "config_option_update", configOptions: configOptions(session) },
      });
    } else if (event.type === "config_changed" && session) {
      session[event.option] = event.value;
      session.configWaiters.get(`${event.option}:${event.value}`)?.();
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: configOptions(session) },
      });
    } else if (event.type === "tool_started") {
      session?.tools.set(event.toolUseId, { tool: event.tool, input: event.input });
      const info = toolInfo(event.tool, event.input);
      const bashTerminal = event.tool === "Bash" && this.terminalOutput;
      const content = bashTerminal ? [{ type: "terminal" as const, terminalId: event.toolUseId }] : diffContent(event.tool, event.input);
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: event.toolUseId,
          status: "pending",
          rawInput: event.input,
          _meta: { claudeCode: { toolName: event.tool }, ...(bashTerminal ? { terminal_info: { terminal_id: event.toolUseId } } : {}) },
          ...(content ? { content } : {}),
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
      const started = session?.tools.get(event.toolUseId);
      const out = started?.tool === "Bash" && event.result !== undefined ? bashOutput(event.result) : undefined;
      const terminal = out && this.terminalOutput;
      await this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolUseId,
          status: event.isError ? "failed" : "completed",
          ...(out && !terminal && out.text ? { content: [{ type: "content", content: { type: "text", text: `\`\`\`console\n${out.text.trimEnd()}\n\`\`\`` } }] } : {}),
          ...(terminal
            ? {
                _meta: {
                  terminal_output: { terminal_id: event.toolUseId, data: out.text },
                  terminal_exit: { terminal_id: event.toolUseId, exit_code: out.exitCode ?? (event.isError ? 1 : 0), signal: null },
                },
              }
            : {}),
        },
      });
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
