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
  await call("POST", "/hello", { protocolVersion: 1, sessionId: "s", modVersion: "0.1.0" });
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
  const fresh = new SessionChannel(join(dir, "cc-acp", "quiet.sock"), 100);
  await fresh.listen();
  await expect(fresh.waitForHello(20)).rejects.toThrow(/did not connect/);
  await fresh.close();
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

test("a newer Owner listening on the same path displaces this channel, which then leaves the new socket alone", async () => {
  let displaced = 0;
  channel.onDisplaced = () => void displaced++;
  const next = new SessionChannel(channel.path, 100);
  await next.listen();
  await expect.poll(() => displaced, { timeout: 3000 }).toBe(1);
  await channel.close();
  expect((await stat(channel.path)).isSocket()).toBe(true);
  await next.close();
  channel = new SessionChannel(join(dir, "cc-acp", "s.sock"), 100);
  await channel.listen();
});

test("waitForBuffered resolves once the hello's announced number of events has arrived", async () => {
  await call("POST", "/hello", { protocolVersion: 1, sessionId: "s", modVersion: "0.1.0", buffered: 3 });
  const seen: ModEvent[] = [];
  channel.onEvent = (e) => void seen.push(e);
  let done = false;
  void channel.waitForBuffered(5000).then(() => (done = true));
  await call("POST", "/events", { events: [{ type: "turn_started", turnId: "a" }, { type: "chunk", kind: "text", text: "x" }] });
  await new Promise((r) => setTimeout(r, 20));
  expect(done).toBe(false);
  await call("POST", "/events", { events: [{ type: "turn_completed", reason: "answer" }] });
  await expect.poll(() => done).toBe(true);
  expect(seen).toHaveLength(3);
});

test("a second hello is accepted so a reconnecting Mod can re-announce itself", async () => {
  const hello = { protocolVersion: 1, sessionId: "s", modVersion: "0.1.0" };
  expect((await call("POST", "/hello", hello)).status).toBe(204);
  expect((await call("POST", "/hello", { ...hello, buffered: 1 })).status).toBe(204);
});

test("requests before hello get 409 so a Mod talking to a new Owner knows to re-hello", async () => {
  const fresh = new SessionChannel(join(dir, "cc-acp", "fresh.sock"), 100);
  await fresh.listen();
  const status = await new Promise<number>((resolve, reject) => {
    request({ socketPath: fresh.path, method: "GET", path: "/poll" }, (res) => resolve(res.statusCode!)).on("error", reject).end();
  });
  await fresh.close();
  expect(status).toBe(409);
});

test("waitForIdle resolves immediately when no turn is in flight", async () => {
  await expect(channel.waitForIdle()).resolves.toBeUndefined();
});

test("waitForIdle waits for turn_completed after a busy hello", async () => {
  await call("POST", "/hello", { protocolVersion: 0, sessionId: "s", modVersion: "old", busy: true });
  let idle = false;
  const waiting = channel.waitForIdle().then(() => (idle = true));
  await new Promise((r) => setTimeout(r, 30));
  expect(idle).toBe(false);
  await call("POST", "/events", { events: [{ type: "turn_completed", reason: "answer" }] });
  await waiting;
  expect(idle).toBe(true);
});

test("expectHello makes waitForHello wait for the replacement Mod's hello", async () => {
  channel.expectHello();
  const waiting = channel.waitForHello(1000);
  await call("POST", "/hello", { protocolVersion: 1, sessionId: "s", modVersion: "new" });
  expect((await waiting).modVersion).toBe("new");
});
