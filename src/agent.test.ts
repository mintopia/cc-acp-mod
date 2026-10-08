import { expect, test, vi } from "vitest";
import * as tmux from "./tmux.js";
import { CcAcpAgent, type HostLauncher } from "./agent.js";
import { ModeTracker } from "./host-session.js";
import { resolveModes } from "./modes.js";
import type { Command, ModEvent } from "./protocol.js";

function harness() {
  const sent: Command[] = [];
  const updates: unknown[] = [];
  const modes = resolveModes([], {}, false);
  const mode = new ModeTracker(modes.initialMode);
  let emit!: (e: ModEvent) => void;
  const launch: HostLauncher = async ({ sessionId, onEvent }) => {
    emit = (e) => onEvent(e, mode);
    return {
      sessionId,
      modes,
      mode,
      channel: {
        send: (c) => {
          sent.push(c);
        },
        close: async () => {},
      },
    };
  };
  const probeReports: string[] = [];
  const agent = new CcAcpAgent({ sessionUpdate: async (u) => void updates.push(u.update) }, "0", launch);
  return { agent, sent, updates, probeReports, emit: (e: ModEvent) => emit(e) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const promptOf = (sessionId: string, text: string) => ({ sessionId, prompt: [{ type: "text" as const, text }] });

test("session/cancel aborts the running turn and the prompt resolves cancelled", async () => {
  const h = harness();
  const { sessionId } = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  const p = h.agent.prompt(promptOf(sessionId, "a"));
  await h.agent.cancel({ sessionId });
  expect(h.sent).toEqual([{ type: "prompt", text: "a" }, { type: "cancel" }]);
  h.emit({ type: "turn_completed", reason: "aborted" });
  expect(await p).toEqual({ stopReason: "cancelled" });
});

test("cancel resolves cancelled even if the turn completed with an answer first", async () => {
  const h = harness();
  const { sessionId } = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  const p = h.agent.prompt(promptOf(sessionId, "a"));
  await h.agent.cancel({ sessionId });
  h.emit({ type: "turn_completed", reason: "answer" });
  expect(await p).toEqual({ stopReason: "cancelled" });
});

test("$/cancel_request (request signal) follows the same path", async () => {
  const h = harness();
  const { sessionId } = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  const ac = new AbortController();
  const p = h.agent.prompt(promptOf(sessionId, "a"), ac.signal);
  ac.abort();
  expect(h.sent).toEqual([{ type: "prompt", text: "a" }, { type: "cancel" }]);
  h.emit({ type: "turn_completed", reason: "aborted" });
  expect(await p).toEqual({ stopReason: "cancelled" });
});

test("a prompt during a running turn is queued and runs afterwards", async () => {
  const h = harness();
  const { sessionId } = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  const first = h.agent.prompt(promptOf(sessionId, "one"));
  const second = h.agent.prompt(promptOf(sessionId, "two"));
  await tick();
  expect(h.sent).toEqual([{ type: "prompt", text: "one" }]);
  h.emit({ type: "turn_completed", reason: "answer" });
  expect(await first).toEqual({ stopReason: "end_turn" });
  expect(h.sent).toEqual([{ type: "prompt", text: "one" }, { type: "prompt", text: "two" }]);
  h.emit({ type: "turn_completed", reason: "answer" });
  expect(await second).toEqual({ stopReason: "end_turn" });
});

test("cancelling a queued prompt removes it without touching the running turn", async () => {
  const h = harness();
  const { sessionId } = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  const first = h.agent.prompt(promptOf(sessionId, "one"));
  const ac = new AbortController();
  const second = h.agent.prompt(promptOf(sessionId, "two"), ac.signal);
  ac.abort();
  expect(await second).toEqual({ stopReason: "cancelled" });
  h.emit({ type: "turn_completed", reason: "answer" });
  expect(await first).toEqual({ stopReason: "end_turn" });
  expect(h.sent).toEqual([{ type: "prompt", text: "one" }]);
});

test("session/new reports the mode catalogue and current mode", async () => {
  const h = harness();
  const res = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  expect(res.modes?.currentModeId).toBe("default");
  expect(res.modes?.availableModes.map((m) => m.id)).toContain("plan");
});

test("session/set_mode probes the Mod after each Shift+Tab and emits current_mode_update", async () => {
  const h = harness();
  const { sessionId } = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  vi.spyOn(tmux, "pressShiftTab").mockResolvedValue();
  const typed: string[] = [];
  vi.spyOn(tmux, "typeCommand").mockImplementation(async (_id, text) => {
    typed.push(text);
    h.emit({ type: "mode", mode: h.probeReports.shift()! });
  });
  h.probeReports.push("acceptEdits", "plan");
  await h.agent.setSessionMode({ sessionId, modeId: "plan" });
  expect(typed).toEqual(["/cc-acp-probe-mode", "/cc-acp-probe-mode"]);
  expect(h.updates).toEqual([
    { sessionUpdate: "current_mode_update", currentModeId: "acceptEdits" },
    { sessionUpdate: "current_mode_update", currentModeId: "plan" },
  ]);
});

test("session/set_mode rejects a mode that is not offered", async () => {
  const h = harness();
  const { sessionId } = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  await expect(h.agent.setSessionMode({ sessionId, modeId: "dontAsk" })).rejects.toThrow(/not available/);
});

test("in-session mode changes emit current_mode_update", async () => {
  const h = harness();
  await h.agent.newSession({ cwd: "/", mcpServers: [] });
  h.emit({ type: "mode", mode: "plan" });
  await tick();
  expect(h.updates).toEqual([{ sessionUpdate: "current_mode_update", currentModeId: "plan" }]);
});
