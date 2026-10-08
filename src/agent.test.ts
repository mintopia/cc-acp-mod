import { expect, test } from "vitest";
import { CcAcpAgent, type HostLauncher } from "./agent.js";
import type { Command, ModEvent } from "./protocol.js";

function harness() {
  const sent: Command[] = [];
  let emit!: (e: ModEvent) => void;
  const launch: HostLauncher = async ({ sessionId, onEvent }) => {
    emit = onEvent;
    return { sessionId, channel: { send: (c) => void sent.push(c), close: async () => {} } };
  };
  const agent = new CcAcpAgent({ sessionUpdate: async () => {} }, "0", launch);
  return { agent, sent, emit: (e: ModEvent) => emit(e) };
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

function steeringHarness(steering: boolean) {
  const sent: Command[] = [];
  const launch: HostLauncher = async ({ sessionId }) => ({
    sessionId,
    steering,
    channel: { send: (c) => void sent.push(c), close: async () => {} },
  });
  return { agent: new CcAcpAgent({ sessionUpdate: async () => {} }, "0", launch), sent };
}

test("steering supported: advertised in _meta and delivered into the running turn", async () => {
  const h = steeringHarness(true);
  const res = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  expect(res._meta).toEqual({ steering: { supported: true } });
  void h.agent.prompt(promptOf(res.sessionId, "a"));
  await h.agent.steer({ sessionId: res.sessionId, prompt: [{ type: "text", text: "go left" }] });
  expect(h.sent).toEqual([{ type: "prompt", text: "a" }, { type: "steer", text: "go left" }]);
});

test("steering unsupported: advertised false and method not found", async () => {
  const h = steeringHarness(false);
  const res = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  expect(res._meta).toEqual({ steering: { supported: false } });
  await expect(h.agent.steer({ sessionId: res.sessionId, prompt: [] })).rejects.toMatchObject({ code: -32601 });
});
