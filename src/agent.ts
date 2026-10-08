import { socketPath } from "./paths.js";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { claudeLoggedIn, terminalAuthMethods } from "./auth.js";
import { formAnswers, questionForm } from "./ask-user-question.js";
import { McpProxy, type HostMcpServer } from "./mcp-proxy.js";
import { launchHostSession, switchModel, MODE_PROBE_COMMAND, type HostSession, type ModeTracker } from "./host-session.js";
import { MODEL_CONFIG_ID, buildModelList, initialModelId, resolveModelId, type ModelInfo } from "./models.js";
import { switchMode, toAcpModeState } from "./modes.js";
import { SessionAttachments, promptText } from "./prompt-content.js";
import { TaskPlan, bashOutput, diffContent, planEntries, toolInfo } from "./tool-mapping.js";
import { findTranscript, listTranscripts, readTranscript } from "./transcript.js";
import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { killSession, pressShiftTab, typeCommand } from "./tmux.js";
import type { ModEvent, PermissionDecision, SlashCommand, TurnReason } from "./protocol.js";

export interface UpdateSink {
  sessionUpdate(params: acp.SessionNotification): Promise<void>;
  createElicitation?(params: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse>;
  requestPermission?(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
}

export type HostLauncher = (opts: {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  env?: NodeJS.ProcessEnv;
  disallowedTools?: string[];
  mcpServers?: Record<string, HostMcpServer>;
  resume?: boolean;
  forkFrom?: string;
  onEvent: (event: ModEvent, mode: ModeTracker) => void;
  onDisplaced?: () => void;
}) => Promise<Pick<HostSession, "sessionId" | "modes" | "mode"> & { steering?: boolean; channel: Pick<HostSession["channel"], "send" | "close"> & Partial<Pick<HostSession["channel"], "answerPermission">> }>;

interface QueuedPrompt {
  text: string;
  resolve: (result: { stopReason: acp.StopReason; usage?: acp.Usage }) => void;
  reject: (err: Error) => void;
  cancelRequested: boolean;
}

interface Session {
  host: Awaited<ReturnType<HostLauncher>>;
  queue: QueuedPrompt[];
  intake?: Promise<void>;
  taskPlan: TaskPlan;
  tools: Map<string, { tool: string; input: Record<string, unknown> }>;
  current?: QueuedPrompt;
  turnUsage?: acp.Usage;
  models: ModelInfo[];
  currentModel: string;
  modelWaiters: Map<string, () => void>;
  effort: string;
  fast: string;
  configWaiters: Map<string, () => void>;
  attachments: SessionAttachments;
  commands?: SlashCommand[];
  pendingPermissions: Map<string, PendingPermission>;
  answeredPermissions: Set<string>;
  drain: () => Promise<void>;
}

interface PendingPermission {
  reject: () => void;
  ask: () => Promise<void>;
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

const MODE_REPORT_TIMEOUT_MS = 5_000;
const KEY_SETTLE_MS = 150;
const PROBE_DRAIN_MS = 500;

const STOP_REASONS: Partial<Record<TurnReason, acp.StopReason>> = {
  answer: "end_turn",
  aborted: "cancelled",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

function sessionState(session: Session) {
  return {
    modes: toAcpModeState(session.host.modes, session.host.mode.current),
    configOptions: configOptions(session),
    _meta: { steering: { supported: session.host.steering === true } },
  };
}

function availableCommands(commands: SlashCommand[]): acp.AvailableCommand[] {
  return commands
    .filter((c) => !c.terminalOnly)
    .map((c) => ({
      name: c.name,
      description: c.description ?? "",
      ...(c.argumentHint ? { input: { hint: c.argumentHint } } : {}),
    }));
}

export class CcAcpAgent {
  private readonly sessions = new Map<string, Session>();
  private formElicitation = false;
  private terminalOutput = false;
  private readonly mcpProxy = new McpProxy();

  constructor(
    private readonly client: UpdateSink,
    private readonly version: string,
    private readonly launch: HostLauncher = launchHostSession,
    private readonly loggedIn: () => Promise<boolean> = claudeLoggedIn,
  ) {}

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    this.terminalOutput = (params.clientCapabilities?._meta as Record<string, unknown> | undefined)?.terminal_output === true;
    this.formElicitation = params.clientCapabilities?.elicitation?.form != null && this.client.createElicitation !== undefined;
    const terminalAuth = (params.clientCapabilities?._meta as Record<string, unknown> | undefined)?.["terminal-auth"] === true;
    const authMethods = terminalAuth && !(await this.loggedIn()) ? terminalAuthMethods() : [];
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      authMethods: authMethods as acp.InitializeResponse["authMethods"],
      agentInfo: { name: "cc-acp", title: "Claude Code (cc-acp)", version: this.version },
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {}, list: {}, resume: {}, close: {}, delete: {}, additionalDirectories: {} }, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } },
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    const session = await this.startSession(sessionId, params.cwd, params.mcpServers, false, undefined, params.additionalDirectories);
    return { sessionId, ...sessionState(session) };;
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const { sessionId } = params;
    for (const update of await readTranscript(sessionId, process.env)) await this.client.sessionUpdate({ sessionId, update });
    const live = this.sessions.get(sessionId);
    if (live) this.mcpProxy.setClient(sessionId, params.mcpServers);
    const session = live ?? (await this.startSession(sessionId, params.cwd, params.mcpServers, true, undefined, params.additionalDirectories));
    return this.reattach(session, live);
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    return listTranscripts({ cwd: params.cwd, cursor: params.cursor });
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    const { sessionId } = params;
    const live = this.sessions.get(sessionId);
    const session = live ?? (await this.startSession(sessionId, params.cwd, params.mcpServers ?? [], true, undefined, params.additionalDirectories));
    return this.reattach(session, live);
  }

  private async reattach(session: Session, live: Session | undefined) {
    await session.drain();
    if (live) for (const pending of [...live.pendingPermissions.values()]) void pending.ask();
    return sessionState(session);
  }

  async closeSession(params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    await this.release(params.sessionId);
    return {};
  }

  async deleteSession(params: acp.DeleteSessionRequest): Promise<acp.DeleteSessionResponse> {
    await this.release(params.sessionId);
    const file = await findTranscript(params.sessionId, process.env);
    if (file) await rm(file, { force: true });
    return {};
  }

  private async release(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) await this.displaced(sessionId);
    await killSession(sessionId);
    await rm(socketPath(sessionId, process.env), { force: true });
  }

  async forkSession(params: acp.ForkSessionRequest): Promise<acp.ForkSessionResponse> {
    const sessionId = randomUUID();
    const session = await this.startSession(sessionId, params.cwd, params.mcpServers ?? [], false, params.sessionId, params.additionalDirectories);
    for (const update of await readTranscript(params.sessionId, process.env)) await this.client.sessionUpdate({ sessionId, update });
    return { sessionId, ...sessionState(session) };;
  }

  private async startSession(sessionId: string, cwd: string, clientServers: acp.McpServer[], resume: boolean, forkFrom?: string, additionalDirectories?: string[]): Promise<Session> {
    const env = process.env;
    let events: Promise<void> = Promise.resolve();
    const earlyPermissions: ModEvent[] = [];
    const pendingCommands = new Map<string, SlashCommand[]>();
    await this.mcpProxy.start();
    const mcpServers = this.mcpProxy.register(sessionId, clientServers.map((s) => s.name));
    this.mcpProxy.setClient(sessionId, clientServers);
    const host = await this.launch({
      sessionId,
      cwd,
      additionalDirectories,
      env,
      mcpServers,
      resume,
      forkFrom,
      disallowedTools: this.formElicitation ? [] : ["AskUserQuestion"],
      onEvent: (event, mode) => {
        if (event.type === "ask_question") return void this.askQuestion(sessionId, event);
        if (event.type === "commands" && !this.sessions.has(sessionId)) return void pendingCommands.set(sessionId, event.commands);
        if (event.type === "permission_request" && !this.sessions.has(sessionId)) return void earlyPermissions.push(event);
        events = events.then(() => this.onEvent(sessionId, event, mode)).catch(() => {});
      },
      onDisplaced: () => void this.displaced(sessionId),
    }).catch((err) => {
      this.mcpProxy.unregister(sessionId);
      throw err;
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
      attachments: new SessionAttachments(sessionId, env),
      pendingPermissions: new Map(),
      answeredPermissions: new Set(),
      drain: () => events,
    };
    session.commands = pendingCommands.get(sessionId);
    pendingCommands.delete(sessionId);
    this.sessions.set(sessionId, session);
    for (const event of earlyPermissions) events = events.then(() => this.onEvent(sessionId, event, host.mode)).catch(() => {});
    if (session.commands) setTimeout(() => void this.sendCommands(sessionId, session.commands!).catch(() => {}), 0);
    return session;
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
    await this.applyModel(session, id);
    return { configOptions: configOptions(session) };
  }

  async setSessionModel(params: { sessionId: string; modelId: string }): Promise<Record<string, never>> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw acp.RequestError.invalidParams(undefined, `Unknown session ${params.sessionId}`);
    const id = resolveModelId(session.models, params.modelId);
    if (!id) throw acp.RequestError.invalidParams(undefined, `Unknown model ${params.modelId}`);
    await this.applyModel(session, id);
    return {};
  }

  private async applyModel(session: Session, id: string): Promise<void> {
    if (id === session.currentModel) return;
    const changed = new Promise<void>((resolve) => session.modelWaiters.set(id, resolve));
    try {
      await switchModel(session.host, id, changed);
    } finally {
      session.modelWaiters.delete(id);
    }
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
    const converted = promptText(params.prompt, session.attachments);
    const text = typeof converted === "string" ? converted : await converted;
    session.host.channel.send({ type: "steer", text });
    return {};
  }

  async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);
    const { host } = session;
    if (!host.modes.availableModes.some((m) => m === params.modeId)) {
      throw new Error(`Mode "${params.modeId}" is not available for this session`);
    }
    await switchMode({
      target: params.modeId,
      current: () => host.mode.current,
      pressShiftTab: () => pressShiftTab(host.sessionId),
      waitForChange: async () => {
        await sleep(KEY_SETTLE_MS);
        const report = host.mode.waitForReport(MODE_REPORT_TIMEOUT_MS);
        await typeCommand(host.sessionId, `/${MODE_PROBE_COMMAND}`);
        const mode = await report;
        await sleep(PROBE_DRAIN_MS);
        return mode;
      },
    });
    return {};
  }

  async prompt(params: acp.PromptRequest, signal?: AbortSignal): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session ${params.sessionId}`);
    const converted = promptText(params.prompt, session.attachments);
    const text = typeof converted === "string" && !session.intake ? converted : await this.afterIntake(session, converted);
    return await new Promise<{ stopReason: acp.StopReason; usage?: acp.Usage }>((resolve, reject) => {
      const entry: QueuedPrompt = { text, resolve, reject, cancelRequested: false };
      session.queue.push(entry);
      signal?.addEventListener("abort", () => this.cancelPrompt(session, entry), { once: true });
      this.startNext(session);
    });
  }

  private afterIntake(session: Session, converted: string | Promise<string>): Promise<string> {
    const ready = Promise.all([converted, session.intake]).then(([text]) => text);
    const intake = ready.then(() => {}, () => {});
    session.intake = intake;
    void intake.then(() => {
      if (session.intake === intake) session.intake = undefined;
    });
    return ready;
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session?.current) this.cancelPrompt(session, session.current);
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async (s) => {
      await s.host.channel.close();
      await s.attachments.cleanup();
    }));
    this.sessions.clear();
    await this.mcpProxy.close();
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
      for (const pending of [...session.pendingPermissions.values()]) pending.reject();
      session.host.channel.send({ type: "cancel" });
      return;
    }
    const index = session.queue.indexOf(entry);
    if (index === -1) return;
    session.queue.splice(index, 1);
    entry.resolve({ stopReason: "cancelled" });
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

  private sendCommands(sessionId: string, commands: SlashCommand[]): Promise<void> {
    return this.client.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: availableCommands(commands) },
    });
  }

  private async bridgePermission(
    sessionId: string,
    session: Session,
    event: Extract<ModEvent, { type: "permission_request" }>,
  ): Promise<void> {
    if (session.pendingPermissions.has(event.requestId) || session.answeredPermissions.has(event.requestId)) return;
    let answered = false;
    const answer = (decision: PermissionDecision) => {
      if (answered) return;
      answered = true;
      session.pendingPermissions.delete(event.requestId);
      session.answeredPermissions.add(event.requestId);
      session.host.channel.answerPermission?.(event.requestId, decision);
    };
    const ask = async () => {
      if (!this.client.requestPermission) return answer("reject");
      const toolCallId = event.toolUseId ?? event.requestId;
      try {
        const res = await this.client.requestPermission({
          sessionId,
          toolCall: { toolCallId, ...toolInfo(event.tool, event.input), rawInput: event.input },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow-with-updates", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        const optionId = res.outcome.outcome === "selected" ? res.outcome.optionId : undefined;
        answer(optionId === "allow-once" ? "allow_once" : optionId === "allow-with-updates" ? "allow_with_updates" : "reject");
      } catch {
      }
    };
    session.pendingPermissions.set(event.requestId, { reject: () => answer("reject"), ask });
    await ask();
  }

  private async displaced(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.mcpProxy.unregister(sessionId);
    const error = new Error("Session taken over by another Adapter");
    const prompts = [...(session.current ? [session.current] : []), ...session.queue.splice(0)];
    session.current = undefined;
    for (const prompt of prompts) prompt.reject(error);
    await session.host.channel.close().catch(() => {});
    await session.attachments.cleanup();
  }

  private async onEvent(sessionId: string, event: ModEvent, mode: ModeTracker): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (event.type === "mode") {
      if (mode.update(event.mode)) {
        await this.client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId: event.mode },
        });
      }
    } else if (event.type === "chunk") {
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
    } else if (event.type === "usage" && session) {
      session.turnUsage = {
        totalTokens: event.inputTokens + event.outputTokens + (event.cachedReadTokens ?? 0) + (event.cachedWriteTokens ?? 0),
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(event.cachedReadTokens !== undefined ? { cachedReadTokens: event.cachedReadTokens } : {}),
        ...(event.cachedWriteTokens !== undefined ? { cachedWriteTokens: event.cachedWriteTokens } : {}),
      };
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "usage_update", used: event.contextUsed, size: event.contextSize },
      });
    } else if (event.type === "commands" && session) {
      session.commands = event.commands;
      await this.sendCommands(sessionId, event.commands);
    } else if (event.type === "title") {
      await this.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "session_info_update", title: event.title, updatedAt: new Date().toISOString() },
      });
    } else if (event.type === "permission_request" && session) {
      void this.bridgePermission(sessionId, session, event);
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
      for (const pending of [...session.pendingPermissions.values()]) pending.reject();
      const stopReason = done.cancelRequested && event.reason !== "error" ? "cancelled" : STOP_REASONS[event.reason];
      const usage = session.turnUsage;
      session.turnUsage = undefined;
      if (stopReason) done.resolve({ stopReason, ...(usage ? { usage } : {}) });
      else done.reject(new Error(`Turn ended with ${event.reason}`));
      this.startNext(session);
    }
  }
}
