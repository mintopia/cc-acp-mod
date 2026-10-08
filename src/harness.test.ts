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

test("session list/resume/close/delete manage sessions from transcripts", async () => {
  const { mkdtemp, mkdir, writeFile, rm, utimes, access } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { listTranscripts } = await import("./transcript.js");
  const config = await mkdtemp(join(tmpdir(), "cc-acp-config-"));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const write = async (id: string, cwd: string, prompt: string, mtime: number) => {
      const dir = join(config, "projects", cwd.replaceAll("/", "-"));
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${id}.jsonl`);
      const lines = [{ type: "user", cwd, message: { role: "user", content: prompt } }, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }];
      await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"));
      await utimes(file, mtime, mtime);
      return file;
    };
    const old = "aaaaaaaa-0000-0000-0000-000000000001";
    const recent = "aaaaaaaa-0000-0000-0000-000000000002";
    const other = "aaaaaaaa-0000-0000-0000-000000000003";
    await write(old, "/tmp/a", "first prompt", 1_000_000);
    const recentFile = await write(recent, "/tmp/a", "second prompt", 2_000_000);
    await write(other, "/tmp/b", "elsewhere", 3_000_000);

    h = await startHarness();
    const init = await h.request<{ agentCapabilities: { sessionCapabilities: Record<string, object> } }>("initialize", { protocolVersion: 1 });
    expect(Object.keys(init.agentCapabilities.sessionCapabilities)).toEqual(expect.arrayContaining(["list", "resume", "close", "delete"]));

    const listed = await h.request<{ sessions: { sessionId: string; cwd: string; title: string }[] }>("session/list", { cwd: "/tmp/a" });
    expect(listed.sessions.map((s) => s.sessionId)).toEqual([recent, old]);
    expect(listed.sessions[0]).toMatchObject({ cwd: "/tmp/a", title: "second prompt" });
    const all = await listTranscripts({}, process.env);
    expect(all.sessions.map((s) => s.sessionId)).toEqual([other, recent, old]);
    const page1 = await listTranscripts({ pageSize: 2 }, process.env);
    expect(page1.sessions.map((s) => s.sessionId)).toEqual([other, recent]);
    const page2 = await listTranscripts({ pageSize: 2, cursor: page1.nextCursor }, process.env);
    expect(page2.sessions.map((s) => s.sessionId)).toEqual([old]);
    expect(page2.nextCursor).toBeUndefined();

    await h.request("session/resume", { sessionId: recent, cwd: "/tmp/a", mcpServers: [] });
    expect(h.resumed.get(recent)).toBe(true);
    expect(h.updates(recent)).toEqual([]);

    const sock = (h.mods.get(recent) as unknown as { socketPath: string }).socketPath;
    await h.request("session/close", { sessionId: recent });
    await expect(access(sock)).rejects.toThrow();
    await access(recentFile);

    await h.request("session/resume", { sessionId: recent, cwd: "/tmp/a", mcpServers: [] });
    await h.request("session/delete", { sessionId: recent });
    await expect(access(recentFile)).rejects.toThrow();
    expect((await h.request<{ sessions: unknown[] }>("session/list", { cwd: "/tmp/a" })).sessions).toHaveLength(1);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    await rm(config, { recursive: true, force: true });
  }
});
