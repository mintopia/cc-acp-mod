import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeMod } from "./testing/fake-mod.js";

const tmux = vi.hoisted(() => ({ killed: 0, startedArgv: [] as string[][], onStart: async () => {} }));

vi.mock("./launch.js", () => ({ checkClaudeVersion: async () => {}, checkTmux: async () => {}, trustDirectory: async () => {} }));
vi.mock("./tmux.js", () => ({
  forwardedEnv: () => ({}),
  hasSession: async () => true,
  killSession: async () => void tmux.killed++,
  sendEnter: async () => {},
  startSession: async (o: { argv: string[] }) => {
    tmux.startedArgv.push(o.argv);
    await tmux.onStart();
  },
}));

const { launchHostSession } = await import("./host-session.js");
const { socketPath } = await import("./paths.js");

let dir: string;
const env = () => ({ ...process.env, XDG_RUNTIME_DIR: dir, CLAUDE_CODE_EXECUTABLE: "claude" });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-acp-host-"));
  tmux.killed = 0;
  tmux.startedArgv = [];
  tmux.onStart = async () => {};
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function reattach(oldHello: { protocolVersion: number; busy?: boolean }, extra: { skewIdleTimeoutMs?: number } = {}, afterOld?: (old: FakeMod) => Promise<void>) {
  const sessionId = "s1";
  const old = new FakeMod(socketPath(sessionId, env()), sessionId);
  const fresh = new FakeMod(socketPath(sessionId, env()), sessionId);
  tmux.onStart = () => fresh.connect();
  const connecting = (async () => {
    for (let i = 0; i < 200; i++) {
      try {
        await old.connect(oldHello);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  })();
  const launching = launchHostSession({ sessionId, cwd: "/", env: env(), resume: true, onEvent: () => {}, ...extra });
  await connecting;
  await afterOld?.(old);
  const host = await launching;
  old.halt();
  fresh.halt();
  await host.channel.close();
  return host;
}

test("matching protocol version Reattaches without relaunching", async () => {
  await reattach({ protocolVersion: 1 });
  expect(tmux.startedArgv).toHaveLength(0);
  expect(tmux.killed).toBe(0);
});

test("version mismatch while idle Revives immediately with resume", async () => {
  await reattach({ protocolVersion: 0 });
  expect(tmux.killed).toBeGreaterThan(0);
  expect(tmux.startedArgv).toHaveLength(1);
  expect(tmux.startedArgv[0]).toEqual(expect.arrayContaining(["--resume", "s1"]));
});

test("version mismatch mid-turn waits for turn_completed before Reviving", async () => {
  await reattach({ protocolVersion: 0, busy: true }, {}, async (old) => {
    await new Promise((r) => setTimeout(r, 100));
    expect(tmux.startedArgv).toHaveLength(0);
    await old.emit({ type: "turn_completed", reason: "answer" });
  });
  expect(tmux.startedArgv).toHaveLength(1);
});

test("version mismatch with a turn that never ends keeps the existing session instead of hanging", async () => {
  await reattach({ protocolVersion: 0, busy: true }, { skewIdleTimeoutMs: 100 });
  expect(tmux.startedArgv).toHaveLength(0);
  expect(tmux.killed).toBe(0);
});
