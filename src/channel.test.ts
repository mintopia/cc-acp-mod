import { mkdtemp, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SessionChannel } from "./channel.js";
import type { ModEvent } from "./protocol.js";

let dir: string;
let channel: SessionChannel;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-acp-test-"));
  channel = new SessionChannel(join(dir, "cc-acp", "s.sock"), 100);
  await channel.listen();
});

afterEach(async () => {
  await channel.close();
  await rm(dir, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: channel.path, method, path }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, body: data }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("socket is created with mode 0600", async () => {
  expect((await stat(channel.path)).mode & 0o777).toBe(0o600);
});

test("hello resolves waitForHello", async () => {
  const hello = { protocolVersion: 1, sessionId: "s", modVersion: "0.1.0" };
  const waiting = channel.waitForHello(1000);
  expect((await call("POST", "/hello", hello)).status).toBe(204);
  expect(await waiting).toEqual(hello);
});

test("waitForHello times out when the Mod never connects", async () => {
  await expect(channel.waitForHello(20)).rejects.toThrow(/did not connect/);
});

test("poll delivers a command sent before or during the poll", async () => {
  channel.send({ type: "prompt", text: "queued" });
  const first = await call("GET", "/poll");
  expect(JSON.parse(first.body)).toEqual({ type: "prompt", text: "queued" });

  const pending = call("GET", "/poll");
  await new Promise((r) => setTimeout(r, 20));
  channel.send({ type: "prompt", text: "live" });
  expect(JSON.parse((await pending).body)).toEqual({ type: "prompt", text: "live" });
});

test("poll returns 204 when the window elapses", async () => {
  expect((await call("GET", "/poll")).status).toBe(204);
});

test("events arrive in emission order", async () => {
  const seen: ModEvent[] = [];
  channel.onEvent = (e) => seen.push(e);
  const events: ModEvent[] = [
    { type: "turn_started", turnId: "t" },
    { type: "chunk", kind: "text", text: "a" },
    { type: "chunk", kind: "text", text: "b" },
    { type: "turn_completed", reason: "answer" },
  ];
  expect((await call("POST", "/events", { events })).status).toBe(204);
  expect(seen).toEqual(events);
});

test("malformed bodies and unknown routes are rejected", async () => {
  expect((await call("POST", "/events", { nope: 1 })).status).toBe(400);
  expect((await call("GET", "/nope")).status).toBe(404);
});

test("permission poll returns an answer given before or during the poll, else 204 after the window", async () => {
  channel.answerPermission("a", "allow_once");
  expect(JSON.parse((await call("GET", "/permission?id=a")).body)).toEqual({ decision: "allow_once" });

  const pending = call("GET", "/permission?id=b");
  await new Promise((r) => setTimeout(r, 20));
  channel.answerPermission("b", "reject");
  expect(JSON.parse((await pending).body)).toEqual({ decision: "reject" });

  expect((await call("GET", "/permission?id=c")).status).toBe(204);
});
