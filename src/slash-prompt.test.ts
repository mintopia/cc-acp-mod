import { describe, expect, it, vi } from "vitest";

type Handler = (...args: any[]) => any;

const MOD_ENTRY: string = "../mod/hooks/register.js";

async function setup(promptText: string, run: (req: { command: string; args: string }) => Promise<any>, submitError?: Error) {
  vi.resetModules();
  const { register } = (await import(MOD_ENTRY)) as { register: (on: Handler) => void };
  const handlers = new Map<string, Handler>();
  const events: any[] = [];
  const runCalls: Array<{ command: string; args: string }> = [];
  const submitted: Array<{ text: string }> = [];
  const processCalls: string[][] = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  let now = 0;
  let polled = false;
  let nextPoll: ((r: { status: number; text: string }) => void) | undefined;
  const $ = {
    session: { id: async () => "sess1", model: async () => "m", messages: async () => [], usage: async () => ({ context: {} }) },
    command: {
      register: async () => {},
      list: async () => [],
      run: async (req: { command: string; args: string }) => {
        runCalls.push(req);
        return run(req);
      },
    },
    prompt: {
      steer: async () => {},
      submit: async (req: { text: string }) => {
        submitted.push(req);
        if (submitError) throw submitError;
      },
    },
    turn: { abort: async () => {} },
    state: { get: async () => ({ value: undefined }), set: async () => {} },
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        const path = new URL(url).pathname;
        if (path === "/events") {
          events.push(...JSON.parse(init!.body!).events);
          return { status: 200, text: "{}" };
        }
        if (path === "/poll") {
          if (polled) return new Promise((resolve) => (nextPoll = resolve));
          polled = true;
          return { status: 200, text: JSON.stringify({ type: "prompt", text: promptText }) };
        }
        return { status: 200, text: "{}" };
      },
    },
    process: {
      run: async (argv: string[]) => {
        processCalls.push(argv);
        const env: Record<string, string> = { CC_ACP_SOCKET_DIR: "/tmp/s", CC_ACP_IDLE_TIMEOUT_MS: "0" };
        return { stdout: argv[0] === "printenv" ? (env[argv[1]] ?? "") : "" };
      },
    },
    clock: { after: (ms: number, fn: () => void) => void timers.push({ at: now + ms, fn }) },
  };
  register(((name: string, a: any, b?: any) => handlers.set(name, b ?? a)) as any);
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      await settle();
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = Math.max(now, due.at);
      due.fn();
    }
    now = target;
    await settle();
  };
  await handlers.get("session.start")!($, {}, async (e: any) => e);
  await advance(0);
  const completions = () => events.filter((e) => e.type === "turn_completed");
  const chunks = () => events.filter((e) => e.type === "chunk");
  const sendCommand = (cmd: unknown) => nextPoll?.({ status: 200, text: JSON.stringify(cmd) });
  return { sendCommand, $, handlers, events, runCalls, submitted, processCalls, advance, completions, chunks };
}

describe("slash prompts", () => {
  it("submits plain text through prompt.submit as the user's own words", async () => {
    const t = await setup("hello there", async () => ({}));
    expect(t.submitted).toEqual([{ text: "hello there", asUser: true }]);
    expect(t.runCalls).toEqual([]);
    expect(t.completions()).toEqual([]);
  });

  it("emits an error completion when prompt.submit rejects", async () => {
    const t = await setup("hello", async () => ({}), new Error("boom"));
    expect(t.completions()).toEqual([{ type: "turn_completed", reason: "error" }]);
  });

  it("runs a slash command with its args", async () => {
    const t = await setup("/model opus", async () => ({ text: "ok" }));
    expect(t.runCalls).toEqual([{ command: "model", args: "opus" }]);
    expect(t.submitted).toEqual([]);
  });

  it("passes empty args for a bare slash command", async () => {
    const t = await setup("/compact", async () => ({ text: "" }));
    expect(t.runCalls).toEqual([{ command: "compact", args: "" }]);
  });

  it("keeps multi-line args intact", async () => {
    const t = await setup("/implement 28\n\nResolve issue", async () => ({ text: "" }));
    expect(t.runCalls).toEqual([{ command: "implement", args: "28\n\nResolve issue" }]);
  });

  it("emits the reply text then an answer completion when text is returned", async () => {
    const t = await setup("/cost", async () => ({ text: "total: $1" }));
    expect(t.chunks()).toEqual([{ type: "chunk", kind: "text", text: "total: $1" }]);
    expect(t.completions()).toEqual([{ type: "turn_completed", reason: "answer" }]);
    const order = t.events.map((e) => e.type).filter((x) => x === "chunk" || x === "turn_completed");
    expect(order).toEqual(["chunk", "turn_completed"]);
  });

  it("skips the chunk when the returned text is empty", async () => {
    const t = await setup("/clear", async () => ({ text: "" }));
    expect(t.chunks()).toEqual([]);
    expect(t.completions()).toEqual([{ type: "turn_completed", reason: "answer" }]);
  });

  it("completes after 2s when no text is returned and no turn starts", async () => {
    const t = await setup("/implement 28", async () => ({}));
    await t.advance(1900);
    expect(t.completions()).toEqual([]);
    await t.advance(200);
    expect(t.completions()).toEqual([{ type: "turn_completed", reason: "answer" }]);
    expect(t.chunks()).toEqual([]);
  });

  it("completes after 2s when the command resolves undefined", async () => {
    const t = await setup("/implement 28", async () => undefined);
    await t.advance(2100);
    expect(t.completions()).toEqual([{ type: "turn_completed", reason: "answer" }]);
  });

  it("emits nothing synthetic when a main-loop turn starts", async () => {
    const t = await setup("/implement 28\n\nResolve issue", async () => ({}));
    await t.handlers.get("turn.start")!(t.$, { turnId: "t1" }, async (e: any) => e);
    await t.advance(5000);
    expect(t.events.some((e) => e.type === "turn_started")).toBe(true);
    expect(t.completions()).toEqual([]);
    expect(t.chunks()).toEqual([]);
  });

  it("still completes when only a subagent turn starts", async () => {
    const t = await setup("/implement 28", async () => ({}));
    await t.handlers.get("turn.start")!(t.$, { turnId: "t1", agentId: "a" }, async (e: any) => e);
    await t.advance(2100);
    expect(t.completions()).toEqual([{ type: "turn_completed", reason: "answer" }]);
  });

  it("reports the error message and completes when the command rejects", async () => {
    const t = await setup("/bogus", async () => {
      throw new Error("unknown command");
    });
    expect(t.chunks()).toEqual([{ type: "chunk", kind: "text", text: "unknown command" }]);
    expect(t.completions()).toEqual([{ type: "turn_completed", reason: "answer" }]);
  });

  it("stringifies non-Error rejections", async () => {
    const t = await setup("/bogus", async () => {
      throw "nope";
    });
    expect(t.chunks()).toEqual([{ type: "chunk", kind: "text", text: "nope" }]);
  });

  it("dismisses a panel command after 3s and replies that it cannot be shown", async () => {
    const t = await setup("/release-notes", () => new Promise(() => {}));
    await t.advance(2900);
    expect(t.completions()).toEqual([]);
    await t.advance(200);
    expect(t.processCalls).toContainEqual(["tmux", "-L", "cc-acp", "send-keys", "-t", "cc-acp-sess1", "Escape"]);
    expect(t.chunks()).toEqual([{ type: "chunk", kind: "text", text: "/release-notes opens an interactive panel, which this Client can't show." }]);
    expect(t.completions()).toEqual([{ type: "turn_completed", reason: "answer" }]);
  });

  it("does not dismiss when the command resolves or a turn starts in time", async () => {
    const t = await setup("/implement 28", async () => ({}));
    await t.advance(5000);
    expect(t.processCalls.some((a) => a.includes("send-keys"))).toBe(false);
    expect(t.completions()).toHaveLength(1);
    const u = await setup("/skill", () => new Promise(() => {}));
    await u.handlers.get("turn.start")!(u.$, { turnId: "t1" }, async (e: any) => e);
    await u.advance(5000);
    expect(u.processCalls.some((a) => a.includes("send-keys"))).toBe(false);
    expect(u.completions()).toEqual([]);
  });

  it("does not dismiss a command that is compacting the conversation", async () => {
    let resolve!: (r: { text?: string }) => void;
    const t = await setup("/compact", () => new Promise((r) => (resolve = r)));
    await t.handlers.get("session.compact")!(t.$, { trigger: "manual" }, async (e: any) => e);
    await t.advance(5000);
    expect(t.processCalls.some((a) => a.includes("send-keys"))).toBe(false);
    expect(t.completions()).toEqual([]);
    resolve({ text: "Compacted" });
    await t.advance(0);
    expect(t.completions()).toEqual([{ type: "turn_completed", reason: "answer" }]);
  });

  it("completes an unresolved command as aborted on cancel", async () => {
    const t = await setup("/release-notes", () => new Promise(() => {}));
    t.sendCommand({ type: "cancel" });
    await t.advance(0);
    expect(t.completions()).toEqual([{ type: "turn_completed", reason: "aborted" }]);
    await t.advance(5000);
    expect(t.completions()).toHaveLength(1);
  });
});
