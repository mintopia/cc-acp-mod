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

test("effort and fast config options are offered, applied via the Host Session and reported", async () => {
  const sent: Command[] = [];
  const updates: any[] = [];
  let emit!: (e: ModEvent) => void;
  const launch: HostLauncher = async ({ sessionId, onEvent }) => {
    emit = onEvent;
    return { sessionId, channel: { send: (c) => void sent.push(c), close: async () => {} } };
  };
  const agent = new CcAcpAgent({ sessionUpdate: async (p) => void updates.push(p.update) }, "0", launch);
  const { sessionId, configOptions } = await agent.newSession({ cwd: "/", mcpServers: [] });
  expect(configOptions!.find((o) => o.id === "effort")).toMatchObject({ category: "thought_level", currentValue: "high" });
  expect(configOptions!.find((o) => o.id === "fast")).toMatchObject({ currentValue: "off" });

  const p = agent.setSessionConfigOption({ sessionId, configId: "effort", value: "max" });
  await tick();
  expect(sent).toEqual([{ type: "set_effort", value: "max" }]);
  emit({ type: "config_changed", option: "effort", value: "max" });
  const res = await p;
  expect(res.configOptions.find((o) => o.id === "effort")).toMatchObject({ currentValue: "max" });
  expect(updates.at(-1)).toMatchObject({ sessionUpdate: "config_option_update" });

  const f = agent.setSessionConfigOption({ sessionId, configId: "fast", value: "on" });
  await tick();
  emit({ type: "config_changed", option: "fast", value: "on" });
  expect((await f).configOptions.find((o) => o.id === "fast")).toMatchObject({ currentValue: "on" });
  await expect(agent.setSessionConfigOption({ sessionId, configId: "effort", value: "bogus" })).rejects.toThrow();
});

function elicitHarness(opts: { form: boolean; respond?: (p: any) => any }) {
  const sent: Command[] = [];
  const launched: { disallowedTools?: string[] }[] = [];
  const asked: any[] = [];
  let emit!: (e: ModEvent) => void;
  const launch: HostLauncher = async ({ sessionId, onEvent, disallowedTools }) => {
    emit = onEvent;
    launched.push({ disallowedTools });
    return { sessionId, channel: { send: (c) => void sent.push(c), close: async () => {} } };
  };
  const agent = new CcAcpAgent(
    {
      sessionUpdate: async () => {},
      createElicitation: async (p) => (asked.push(p), opts.respond?.(p) ?? { action: "accept", content: { q0: "pg" } }),
    },
    "0",
    launch,
  );
  const init = agent.initialize({ protocolVersion: 1, clientCapabilities: opts.form ? { elicitation: { form: {} } } : {} });
  return { agent, sent, asked, launched, init, emit: (e: ModEvent) => emit(e) };
}

const ask: ModEvent = { type: "ask_question", requestId: "r1", questions: [{ question: "Which db?", options: [{ label: "pg" }, { label: "sqlite" }] }] };

test("AskUserQuestion is shown as a form elicitation and the answer returns to the Mod", async () => {
  const h = elicitHarness({ form: true });
  await h.init;
  const { sessionId } = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  expect(h.launched[0].disallowedTools).toEqual([]);
  h.emit(ask);
  await tick();
  expect(h.asked[0]).toMatchObject({ mode: "form", sessionId });
  expect(h.asked[0].requestedSchema.properties.q0.oneOf.map((o: any) => o.const)).toEqual(["pg", "sqlite"]);
  expect(h.sent).toEqual([{ type: "question_answer", requestId: "r1", answers: { "Which db?": "pg" } }]);
});

test("declined elicitation answers null", async () => {
  const h = elicitHarness({ form: true, respond: () => ({ action: "decline" }) });
  await h.init;
  await h.agent.newSession({ cwd: "/", mcpServers: [] });
  h.emit(ask);
  await tick();
  expect(h.sent).toEqual([{ type: "question_answer", requestId: "r1", answers: null }]);
});

test("clients without form elicitation get AskUserQuestion disallowed and never receive elicitation/create", async () => {
  const h = elicitHarness({ form: false });
  await h.init;
  await h.agent.newSession({ cwd: "/", mcpServers: [] });
  expect(h.launched[0].disallowedTools).toEqual(["AskUserQuestion"]);
  h.emit(ask);
  await tick();
  expect(h.asked).toEqual([]);
  expect(h.sent).toEqual([{ type: "question_answer", requestId: "r1", answers: null }]);
});

function permissionHarness(pick: (req: any) => Promise<any>) {
  const answers: [string, string][] = [];
  const requests: any[] = [];
  let emit!: (e: ModEvent) => void;
  const sent: Command[] = [];
  const launch: HostLauncher = async ({ sessionId, onEvent }) => {
    emit = onEvent;
    return {
      sessionId,
      channel: { send: (c) => void sent.push(c), close: async () => {}, answerPermission: (id, d) => void answers.push([id, d]) },
    };
  };
  const agent = new CcAcpAgent(
    { sessionUpdate: async () => {}, requestPermission: (p) => (requests.push(p), pick(p)) },
    "0",
    launch,
  );
  const request = { type: "permission_request" as const, requestId: "r1", tool: "Bash", input: { command: "ls" }, toolUseId: "t1" };
  return { agent, answers, requests, sent, emit: (e: ModEvent) => emit(e), request };
}

test.each([
  ["allow-once", "allow_once"],
  ["allow-with-updates", "allow_with_updates"],
  ["reject", "reject"],
])("permission option %s maps to %s", async (optionId, decision) => {
  const h = permissionHarness(async () => ({ outcome: { outcome: "selected", optionId } }));
  const { sessionId } = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  h.emit(h.request);
  await tick();
  expect(h.requests[0]).toMatchObject({
    sessionId,
    toolCall: { toolCallId: "t1" },
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-with-updates", kind: "allow_always" },
      { optionId: "reject", kind: "reject_once" },
    ],
  });
  expect(h.answers).toEqual([["r1", decision]]);
});

test("a pending permission request waits, and session/cancel denies it", async () => {
  const h = permissionHarness(() => new Promise(() => {}));
  const { sessionId } = await h.agent.newSession({ cwd: "/", mcpServers: [] });
  const p = h.agent.prompt(promptOf(sessionId, "a"));
  h.emit(h.request);
  await tick();
  expect(h.answers).toEqual([]);
  await h.agent.cancel({ sessionId });
  expect(h.answers).toEqual([["r1", "reject"]]);
  h.emit({ type: "turn_completed", reason: "aborted" });
  expect(await p).toEqual({ stopReason: "cancelled" });
});

test("a cancelled outcome from the client denies the tool", async () => {
  const h = permissionHarness(async () => ({ outcome: { outcome: "cancelled" } }));
  await h.agent.newSession({ cwd: "/", mcpServers: [] });
  h.emit(h.request);
  await tick();
  expect(h.answers).toEqual([["r1", "reject"]]);
});
