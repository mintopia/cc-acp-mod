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
