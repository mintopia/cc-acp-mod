import { afterEach, beforeEach, expect, test, vi } from "vitest";

const enters = vi.hoisted(() => ({ calls: [] as string[], fail: false }));

vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number) => new Promise((r) => globalThis.setTimeout(r, ms)) }));
vi.mock("./launch.js", () => ({ checkClaudeVersion: async () => {}, checkTmux: async () => {}, trustDirectory: async () => {} }));
vi.mock("./tmux.js", () => ({
  forwardedEnv: () => ({}),
  hasSession: async () => true,
  killSession: async () => {},
  sendEnter: async (id: string) => {
    enters.calls.push(id);
    if (enters.fail) throw new Error("no tmux");
  },
  startSession: async () => {},
}));

const { switchModel } = await import("./host-session.js");

const makeHost = () => {
  const send = vi.fn();
  return { host: { sessionId: "s1", channel: { send } }, send };
};

beforeEach(() => {
  vi.useFakeTimers();
  enters.calls = [];
  enters.fail = false;
});
afterEach(() => vi.useRealTimers());

test("sends set_model and resolves once the Mod reports the change", async () => {
  const { host, send } = makeHost();
  let report!: () => void;
  const changed = new Promise<void>((r) => (report = r));
  const pending = switchModel(host, "opus", changed);
  expect(send).toHaveBeenCalledWith({ type: "set_model", id: "opus" });
  await vi.advanceTimersByTimeAsync(2_000);
  report();
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
  expect(enters.calls).toEqual(["s1", "s1"]);
});

test("does not press Enter when the change is already reported", async () => {
  const { host } = makeHost();
  const pending = switchModel(host, "opus", Promise.resolve());
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
  expect(enters.calls).toEqual([]);
});

test("keeps polling when sendEnter fails", async () => {
  enters.fail = true;
  const { host } = makeHost();
  let report!: () => void;
  const changed = new Promise<void>((r) => (report = r));
  const pending = switchModel(host, "opus", changed);
  await vi.advanceTimersByTimeAsync(2_000);
  report();
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(pending).resolves.toBeUndefined();
  expect(enters.calls.length).toBeGreaterThanOrEqual(2);
});

test("rejects after the timeout when the change never arrives", async () => {
  const { host } = makeHost();
  const pending = switchModel(host, "opus", new Promise(() => {}));
  const assertion = expect(pending).rejects.toThrow("Model did not switch to opus");
  await vi.advanceTimersByTimeAsync(31_000);
  await assertion;
  expect(enters.calls.length).toBeGreaterThanOrEqual(29);
});
