import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: any[]) => any;

async function setup(idleMs: string) {
  vi.resetModules();
  const { register } = await import("../mod/hooks/register.js");
  const handlers = new Map<string, Handler>();
  const ran: string[][] = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  const $ = {
    session: { id: async () => "sess1", model: async () => "m", messages: async () => [], usage: async () => ({ context: {} }) },
    command: { register: async () => {}, list: async () => [] },
    prompt: { steer: async () => {} },
    state: { get: async () => ({ value: undefined }), set: async () => {} },
    http: { fetch: async () => { throw new Error("no adapter"); } },
    process: {
      run: async (argv: string[]) => {
        ran.push(argv);
        const env: Record<string, string> = { CC_ACP_SOCKET_DIR: "/tmp/s", CC_ACP_IDLE_TIMEOUT_MS: idleMs };
        return { stdout: argv[0] === "printenv" ? (env[argv[1]] ?? "") : "" };
      },
    },
    clock: { after: (ms: number, fn: () => void) => void timers.push({ at: Date.now() + ms, fn }) },
  };
  register(((name: string, a: any, b?: any) => handlers.set(name, b ?? a)) as any);
  const advance = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    for (let i = 0; i < 20; i++) {
      const due = timers.filter((t) => t.at <= Date.now());
      for (const t of due) timers.splice(timers.indexOf(t), 1);
      for (const t of due) t.fn();
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    }
  };
  const killed = () => ran.some((a) => a[0] === "tmux" && a.includes("kill-session"));
  return { $, handlers, advance, killed, ran };
}

describe("idle reaping", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("kills an unowned idle session and removes its socket", async () => {
    const t = await setup("1000");
    await t.handlers.get("session.start")!(t.$, {}, async (e: any) => e);
    await t.advance(1500);
    expect(t.killed()).toBe(true);
    expect(t.ran).toContainEqual(["rm", "-f", "/tmp/s/sess1.sock"]);
  });

  it("does not reap mid-turn", async () => {
    const t = await setup("1000");
    await t.handlers.get("session.start")!(t.$, {}, async (e: any) => e);
    await t.handlers.get("turn.start")!(t.$, { turnId: "t" }, async (e: any) => e);
    await t.advance(5000);
    expect(t.killed()).toBe(false);
  });

  it("does not reapwhile a permission answer is pending", async () => {
    const t = await setup("1000");
    await t.handlers.get("session.start")!(t.$, {}, async (e: any) => e);
    const perm = t.handlers.get("classic.PermissionRequest")!;
    void perm(t.$, { tool_name: "Bash", tool_input: {} }, async (e: any) => e);
    await t.advance(5000);
    expect(t.killed()).toBe(false);
  });

  it("0 disables reaping", async () => {
    const t = await setup("0");
    await t.handlers.get("session.start")!(t.$, {}, async (e: any) => e);
    await t.advance(10_000_000);
    expect(t.killed()).toBe(false);
  });
});
