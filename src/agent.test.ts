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

function recordingHarness() {
  const updates: any[] = [];
  let emit!: (e: ModEvent) => void;
  const launch: HostLauncher = async ({ sessionId, onEvent }) => {
    emit = onEvent;
    return { sessionId, channel: { send: () => {}, close: async () => {} } };
  };
  const agent = new CcAcpAgent({ sessionUpdate: async (p) => void updates.push(p.update) }, "0", launch);
  return { agent, updates, emit: (e: ModEvent) => emit(e) };
}

test("thinking chunks become agent_thought_chunk", async () => {
  const h = recordingHarness();
  await h.agent.newSession({ cwd: "/", mcpServers: [] });
  h.emit({ type: "chunk", kind: "thinking", text: "hm" });
  await tick();
  expect(h.updates).toEqual([{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } }]);
});

test("tool use produces tool_call with kind, title and toolName, then completed/failed updates", async () => {
  const h = recordingHarness();
  await h.agent.newSession({ cwd: "/", mcpServers: [] });
  h.emit({ type: "tool_started", toolUseId: "t1", tool: "Edit", input: { file_path: "src/a.ts" } });
  h.emit({ type: "tool_finished", toolUseId: "t1", isError: false });
  h.emit({ type: "tool_finished", toolUseId: "t2", isError: true });
  await tick();
  expect(h.updates[0]).toMatchObject({
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    kind: "edit",
    title: "Edit src/a.ts",
    status: "pending",
    _meta: { claudeCode: { toolName: "Edit" } },
  });
  expect(h.updates[1]).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
  expect(h.updates[2]).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
  expect(h.updates[3]).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed" });
});

test("TodoWrite produces a plan update", async () => {
  const h = recordingHarness();
  await h.agent.newSession({ cwd: "/", mcpServers: [] });
  h.emit({ type: "tool_started", toolUseId: "t1", tool: "TodoWrite", input: { todos: [{ content: "a", status: "pending", activeForm: "A" }] } });
  await tick();
  expect(h.updates[2]).toEqual({ sessionUpdate: "plan", entries: [{ content: "a", status: "pending", priority: "medium" }] });
});

test("TaskCreate and TaskUpdate produce plan updates", async () => {
  const h = recordingHarness();
  await h.agent.newSession({ cwd: "/", mcpServers: [] });
  h.emit({ type: "tool_started", toolUseId: "t1", tool: "TaskCreate", input: { subject: "A", description: "d" } });
  h.emit({ type: "tool_finished", toolUseId: "t1", isError: false, result: { task: { id: "1", subject: "A" } } });
  h.emit({ type: "tool_started", toolUseId: "t2", tool: "TaskUpdate", input: { taskId: "1", status: "in_progress" } });
  h.emit({ type: "tool_finished", toolUseId: "t2", isError: false, result: { success: true, taskId: "1", updatedFields: ["status"] } });
  await tick();
  const plans = h.updates.filter((u) => u.sessionUpdate === "plan");
  expect(plans).toEqual([
    { sessionUpdate: "plan", entries: [{ content: "A", status: "pending", priority: "medium" }] },
    { sessionUpdate: "plan", entries: [{ content: "A", status: "in_progress", priority: "medium" }] },
  ]);
});
