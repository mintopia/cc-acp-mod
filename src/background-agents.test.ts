import { describe, expect, it, vi } from "vitest";

type Handler = (...args: any[]) => any;

const MOD_ENTRY: string = "../mod/hooks/register.js";

async function setup(agents: () => any[]) {
  vi.resetModules();
  const { register } = (await import(MOD_ENTRY)) as { register: (on: Handler) => void };
  const handlers = new Map<string, Handler>();
  const events: any[] = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  let now = 0;
  const $ = {
    session: { id: async () => "sess1", model: async () => "m", messages: async () => [], usage: async () => ({ context: {} }) },
    command: { register: async () => {}, list: async () => [] },
    agent: { list: async () => agents() },
    prompt: { steer: async () => {} },
    state: { get: async () => ({ value: undefined }), set: async () => {} },
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        if (new URL(url).pathname === "/events") events.push(...JSON.parse(init!.body!).events);
        return { status: 200, text: "{}" };
      },
    },
    process: { run: async (argv: string[]) => ({ stdout: argv[0] === "printenv" && argv[1] === "CC_ACP_SOCKET_DIR" ? "/tmp/s" : "" }) },
    clock: { after: (ms: number, fn: () => void) => void timers.push({ at: now + ms, fn }) },
  };
  register(((name: string, a: any, b?: any) => handlers.set(name, b ?? a)) as any);
  const advance = async (ms: number) => {
    now += ms;
    for (let i = 0; i < 10; i++) {
      const due = timers.filter((t) => t.at <= now);
      for (const t of due) timers.splice(timers.indexOf(t), 1);
      for (const t of due) t.fn();
      await new Promise((r) => setImmediate(r));
    }
  };
  await handlers.get("session.start")!($, {}, async (e: any) => e);
  await advance(0);
  const pass = async (e: any) => e;
  return { $, handlers, events, advance, pass };
}

describe("background subagents", () => {
  it("reports live agents on turn completion and watches until they finish", async () => {
    let status = "running";
    const t = await setup(() => [{ id: "a1", status }, { id: "a2", status: "completed" }]);
    await t.handlers.get("turn.complete")!(t.$, { reason: "answer" }, t.pass);
    expect(t.events.filter((e) => e.type === "turn_completed")).toEqual([{ type: "turn_completed", reason: "answer", backgroundAgents: 1 }]);
    status = "completed";
    await t.advance(2_100);
    expect(t.events.filter((e) => e.type === "background_agents")).toEqual([{ type: "background_agents", count: 0 }]);
  });

  it("omits backgroundAgents when none are live or the turn did not answer", async () => {
    const t = await setup(() => [{ id: "a1", status: "running" }]);
    await t.handlers.get("turn.complete")!(t.$, { reason: "aborted" }, t.pass);
    expect(t.events.find((e) => e.type === "turn_completed")).toEqual({ type: "turn_completed", reason: "aborted" });
    const none = await setup(() => [{ id: "a1", status: "idle" }]);
    await none.handlers.get("turn.complete")!(none.$, { reason: "answer" }, none.pass);
    expect(none.events.find((e) => e.type === "turn_completed")).toEqual({ type: "turn_completed", reason: "answer" });
  });

  it("forwards subagent tool calls tagged with the spawning tool use id", async () => {
    const t = await setup(() => []);
    await t.handlers.get("agent.spawn")!(t.$, { tool_use_id: "toolu_agent" }, async () => ({ agentId: "sub1" }));
    await t.handlers.get("tool.call")!(t.$, { tool: "Bash", tool_use_id: "b1", agentId: "sub1", command: "ls" }, async () => ({ result: "x" }));
    await t.handlers.get("tool.call")!(t.$, { tool: "Bash", tool_use_id: "b2", agentId: "unknown" }, async () => ({ result: "x" }));
    expect(t.events.filter((e) => e.type.startsWith("tool_"))).toEqual([
      { type: "tool_started", toolUseId: "b1", tool: "Bash", input: { command: "ls" }, parentToolUseId: "toolu_agent" },
      { type: "tool_finished", toolUseId: "b1", isError: false, result: "x", parentToolUseId: "toolu_agent" },
    ]);
  });

  it("forwards subagent text chunks with the parent id and does not emit subagent turn_started", async () => {
    const t = await setup(() => []);
    await t.handlers.get("agent.spawn")!(t.$, { tool_use_id: "toolu_agent" }, async () => ({ agentId: "sub1" }));
    await t.handlers.get("turn.start")!(t.$, { turnId: "s", agentId: "sub1" }, t.pass);
    const step = t.handlers.get("turn.step")!;
    for await (const _ of step(t.$, { agentId: "sub1" }, async function* () { yield { kind: "text", text: "hi" }; })) void _;
    expect(t.events.filter((e) => e.type === "chunk" || e.type === "turn_started")).toEqual([{ type: "chunk", kind: "text", text: "hi", parentToolUseId: "toolu_agent" }]);
  });
});
