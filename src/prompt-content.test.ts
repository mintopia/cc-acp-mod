import { existsSync, readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { CcAcpAgent, type HostLauncher } from "./agent.js";
import { ModeTracker } from "./host-session.js";
import { resolveModes } from "./modes.js";
import type { Command } from "./protocol.js";

function harness() {
  const sent: Command[] = [];
  const modes = resolveModes([], {}, false);
  const launch: HostLauncher = async ({ sessionId }) => ({
    sessionId,
    modes,
    mode: new ModeTracker(modes.initialMode),
    channel: { send: (c) => void sent.push(c), close: async () => {} },
  });
  return { agent: new CcAcpAgent({ sessionUpdate: async () => {} }, "0", launch), sent };
}

const PNG = Buffer.from("png-bytes");

test("images are saved to a session dir, resources inlined, caps advertised, files cleaned on close", async () => {
  const h = harness();
  const init = await h.agent.initialize({ protocolVersion: 1 } as never);
  expect(init.agentCapabilities?.promptCapabilities).toEqual({ image: true, embeddedContext: true });
  const { sessionId } = await h.agent.newSession({ cwd: "/tmp", mcpServers: [] });
  void h.agent.prompt({
    sessionId,
    prompt: [
      { type: "text", text: "look" },
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///a.txt", text: "hello" } },
      { type: "resource_link", name: "doc", uri: "https://example.com/doc" },
    ],
  });
  await vi.waitFor(() => expect(h.sent.some((c) => c.type === "prompt")).toBe(true));
  const text = (h.sent[0] as { text: string }).text;
  const path = /\[Image attached: (.+?)\]/.exec(text)![1]!;
  expect(readFileSync(path)).toEqual(PNG);
  expect(text).toContain('<resource uri="file:///a.txt">\nhello\n</resource>');
  expect(text).toContain("[Resource: doc (https://example.com/doc)]");
  await h.agent.close();
  expect(existsSync(path)).toBe(false);
});

test("attachments from separate prompts in one session never share a path", async () => {
  const h = harness();
  const { sessionId } = await h.agent.newSession({ cwd: "/tmp", mcpServers: [] });
  const img = (b: string) => ({ sessionId, prompt: [{ type: "image" as const, data: Buffer.from(b).toString("base64"), mimeType: "image/png" }] });
  void h.agent.prompt(img("first"));
  void h.agent.prompt(img("second"));
  await vi.waitFor(() => expect(h.sent.some((c) => c.type === "prompt")).toBe(true));
  await h.agent.cancel({ sessionId });
  const paths = h.sent.filter((c) => c.type === "prompt").map((c) => /\[Image attached: (.+?)\]/.exec((c as { text: string }).text)![1]!);
  expect(readFileSync(paths[0]!, "utf8")).toBe("first");
  await h.agent.close();
});

test("a text prompt sent after an image prompt queues behind it", async () => {
  const h = harness();
  const { sessionId } = await h.agent.newSession({ cwd: "/tmp", mcpServers: [] });
  void h.agent.prompt({ sessionId, prompt: [{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" }] });
  void h.agent.prompt({ sessionId, prompt: [{ type: "text", text: "after" }] });
  await vi.waitFor(() => expect(h.sent.some((c) => c.type === "prompt")).toBe(true));
  const first = h.sent.find((c) => c.type === "prompt") as { text: string };
  expect(first.text).toMatch(/\[Image attached: /);
  await h.agent.close();
});
