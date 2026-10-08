import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { launchHostSession, MODE_PROBE_COMMAND, type HostSession, type ModeTracker } from "./host-session.js";
import { switchMode, toAcpModeState } from "./modes.js";
import { pressShiftTab, typeCommand } from "./tmux.js";
import type { ModEvent, TurnReason } from "./protocol.js";

export interface UpdateSink {
  sessionUpdate(params: acp.SessionNotification): Promise<void>;
}

export type HostLauncher = (opts: {
  sessionId: string;
  cwd: string;
  onEvent: (event: ModEvent, mode: ModeTracker) => void;
}) => Promise<Pick<HostSession, "sessionId" | "modes" | "mode"> & { channel: Pick<HostSession["channel"], "send" | "close"> }>;

interface QueuedPrompt {
  text: string;
  resolve: (stopReason: acp.StopReason) => void;
  reject: (err: Error) => void;
  cancelRequested: boolean;
}

interface Session {
  host: Awaited<ReturnType<HostLauncher>>;
  queue: QueuedPrompt[];
  current?: QueuedPrompt;
}

const MODE_REPORT_TIMEOUT_MS = 5_000;
const KEY_SETTLE_MS = 150;
const PROBE_DRAIN_MS = 500;

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
    const host = await this.launch({
      sessionId,
      cwd: params.cwd,
      onEvent: (event, mode) => void this.onEvent(sessionId, event, mode).catch(() => {}),
    });
    this.sessions.set(sessionId, { host, queue: [] });
    return { sessionId, modes: toAcpModeState(host.modes, host.mode.current) };
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
        await new Promise((r) => setTimeout(r, KEY_SETTLE_MS));
        const report = host.mode.waitForReport(MODE_REPORT_TIMEOUT_MS);
        await typeCommand(host.sessionId, `/${MODE_PROBE_COMMAND}`);
        const mode = await report;
        await new Promise((r) => setTimeout(r, PROBE_DRAIN_MS));
        return mode;
      },
    });
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
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } },
      });
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
