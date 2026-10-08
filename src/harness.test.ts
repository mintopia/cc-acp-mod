import { afterEach, expect, test } from "vitest";
import { schemaViolation, startHarness, type Harness } from "./testing/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

test("tracer bullet: text prompt streams chunks and ends the turn, all schema-valid", async () => {
  h = await startHarness();
  const { sessionId, mod } = await h.newSession();

  const prompt = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
  expect(await mod.nextCommand((c) => c.type === "prompt")).toEqual({ type: "prompt", text: "hello" });
  await mod.emit(
    { type: "turn_started", turnId: "t1" },
    { type: "chunk", kind: "text", text: "Hi " },
    { type: "chunk", kind: "text", text: "there" },
    { type: "turn_completed", reason: "answer" },
  );

  expect(await prompt).toEqual({ stopReason: "end_turn" });
  expect(h.updates(sessionId)).toEqual([
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi " } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } },
  ]);
});

test("cancel notification reaches the Mod and the prompt resolves cancelled", async () => {
  h = await startHarness();
  const { sessionId, mod } = await h.newSession();

  const prompt = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
  await mod.nextCommand((c) => c.type === "prompt");
  await h.notify("session/cancel", { sessionId });
  await mod.nextCommand((c) => c.type === "cancel");
  await mod.emit({ type: "turn_completed", reason: "aborted" });

  expect(await prompt).toEqual({ stopReason: "cancelled" });
});

test("the schema validator rejects malformed Adapter output", () => {
  const bad = { jsonrpc: "2.0" as const, method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "bogus" } } };
  expect(schemaViolation(bad)).toBeTruthy();
  const good = { jsonrpc: "2.0" as const, id: 1, result: { stopReason: "end_turn" } };
  expect(schemaViolation(good, "session/prompt")).toBeUndefined();
  expect(schemaViolation({ ...good, result: { stopReason: "nonsense" } }, "session/prompt")).toBeTruthy();
});

test("session/load replays the transcript, revives with resume, and the session accepts prompts", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const config = await mkdtemp(join(tmpdir(), "cc-acp-config-"));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const sessionId = "11111111-2222-3333-4444-555555555555";
    await mkdir(join(config, "projects", "-tmp-x"), { recursive: true });
    const lines = [
      { type: "user", message: { role: "user", content: "<command-name>/foo</command-name>" } },
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "hi" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    ];
    await writeFile(join(config, "projects", "-tmp-x", `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));

    h = await startHarness();
    const res = await h.request<{ modes: { availableModes: { id: string }[] } }>("session/load", { sessionId, cwd: "/", mcpServers: [] });
    expect(res.modes.availableModes.map((m) => m.id)).toContain("auto");
    expect(h.updates(sessionId).map((u) => u.sessionUpdate)).toEqual([
      "user_message_chunk", "agent_thought_chunk", "agent_message_chunk", "tool_call", "tool_call_update",
    ]);
    expect(h.resumed.get(sessionId)).toBe(true);

    const prompt = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] });
    const mod = h.mods.get(sessionId)!;
    await mod.nextCommand((c) => c.type === "prompt");
    await mod.emit({ type: "turn_completed", reason: "answer" });
    expect(await prompt).toEqual({ stopReason: "end_turn" });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    await rm(config, { recursive: true, force: true });
  }
});

test("session/fork returns a new session with the source history, launched from the source, leaving the source untouched", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const config = await mkdtemp(join(tmpdir(), "cc-acp-config-"));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const source = "11111111-2222-3333-4444-555555555556";
    await mkdir(join(config, "projects", "-tmp-x"), { recursive: true });
    const lines = [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    ];
    await writeFile(join(config, "projects", "-tmp-x", `${source}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));

    h = await startHarness();
    const init = await h.request<{ agentCapabilities: { sessionCapabilities: { fork: object } } }>("initialize", { protocolVersion: 1 });
    expect(init.agentCapabilities.sessionCapabilities.fork).toEqual({});

    const res = await h.request<{ sessionId: string }>("session/fork", { sessionId: source, cwd: "/", mcpServers: [] });
    expect(res.sessionId).not.toBe(source);
    expect(h.forkedFrom.get(res.sessionId)).toBe(source);
    expect(h.updates(res.sessionId).map((u) => u.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk"]);
    expect(h.updates(source)).toEqual([]);
    expect(h.mods.has(source)).toBe(false);

    const prompt = h.request("session/prompt", { sessionId: res.sessionId, prompt: [{ type: "text", text: "again" }] });
    const mod = h.mods.get(res.sessionId)!;
    await mod.nextCommand((c) => c.type === "prompt");
    await mod.emit({ type: "turn_completed", reason: "answer" });
    expect(await prompt).toEqual({ stopReason: "end_turn" });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    await rm(config, { recursive: true, force: true });
  }
});
