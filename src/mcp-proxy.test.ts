import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { DISCONNECTED_MESSAGE, McpProxy } from "./mcp-proxy.js";
import { mcpArgs } from "./host-session.js";

const servers: Server[] = [];
const proxies: McpProxy[] = [];

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((p) => p.close()));
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function startProxy(sessionId: string, names: string[]) {
  const proxy = new McpProxy();
  proxies.push(proxy);
  await proxy.start();
  return { proxy, config: proxy.register(sessionId, names) };
}

async function rpc(url: string, method = "tools/list", id = 1) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method }),
  });
  return { status: res.status, body: (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } } };
}

const http = (url: string, token: string): acp.McpServer => ({ type: "http", name: "harmonic", url, headers: [{ name: "authorization", value: `Bearer ${token}` }] });

test("http server is forwarded with the Client's headers and swaps credentials without a restart", async () => {
  const upstream = await listen(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const { id, method } = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { auth: req.headers.authorization, method } }));
  });
  const { proxy, config } = await startProxy("s1", ["harmonic"]);
  proxy.setClient("s1", [http(upstream, "one")]);

  expect((await rpc(config.harmonic!.url)).body.result).toEqual({ auth: "Bearer one", method: "tools/list" });
  proxy.setClient("s1", [http(upstream, "two")]);
  expect((await rpc(config.harmonic!.url)).body.result).toEqual({ auth: "Bearer two", method: "tools/list" });
});

test("http server event-stream responses are streamed through", async () => {
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
  });
  const { proxy, config } = await startProxy("s1", ["harmonic"]);
  proxy.setClient("s1", [http(upstream, "t")]);
  const res = await fetch(config.harmonic!.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }) });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(await res.text()).toContain('"ok":true');
});

test("stdio server is spawned and bridged", async () => {
  const { proxy, config } = await startProxy("s1", ["local"]);
  proxy.setClient("s1", [
    { name: "local", command: process.execPath, args: [fileURLToPath(new URL("./testing/echo-mcp-stdio.mjs", import.meta.url))], env: [] },
  ]);
  expect((await rpc(config.local!.url, "initialize")).body.result).toEqual({ via: "stdio", method: "initialize" });
  expect((await rpc(config.local!.url, "tools/list", 2)).body.result).toEqual({ via: "stdio", method: "tools/list" });
  const notification = await fetch(config.local!.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  expect(notification.status).toBe(202);
});

test("legacy SSE server is bridged", async () => {
  let stream: import("node:http").ServerResponse | undefined;
  const upstream = await listen(async (req, res) => {
    if (req.method === "GET") {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages?x=1\n\n");
      return;
    }
    let body = "";
    for await (const c of req) body += c;
    const { id, method } = JSON.parse(body);
    res.writeHead(202).end();
    stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { via: "sse", method, url: req.url, auth: req.headers.authorization } })}\n\n`);
  });
  const { proxy, config } = await startProxy("s1", ["legacy"]);
  proxy.setClient("s1", [{ type: "sse", name: "legacy", url: `${upstream}/sse`, headers: [{ name: "authorization", value: "Bearer t" }] }]);
  expect((await rpc(config.legacy!.url)).body.result).toEqual({ via: "sse", method: "tools/list", url: "/messages?x=1", auth: "Bearer t" });
});

test("calls while detached fail fast with a Client disconnected error", async () => {
  const { proxy, config } = await startProxy("s1", ["harmonic"]);
  const detached = await rpc(config.harmonic!.url);
  expect(detached.body.error?.message).toBe(DISCONNECTED_MESSAGE);
  expect(detached.body.error?.message).toMatch(/Client disconnected/);

  const upstream = await listen(() => {});
  proxy.setClient("s1", [http(upstream, "t")]);
  const hung = rpc(config.harmonic!.url);
  await new Promise((r) => setTimeout(r, 50));
  proxy.detach("s1");
  expect((await hung).body.error?.message).toMatch(/Client disconnected/);
});

test("unknown endpoints are 404 and the Host Session config only references the proxy", async () => {
  const { config, proxy } = await startProxy("s1", ["a", "b"]);
  expect(Object.values(config).every((s) => s.type === "http" && s.url.startsWith("http://127.0.0.1:"))).toBe(true);
  expect((await fetch(config.a!.url.replace("/a", "/zzz"), { method: "POST", body: "{}" })).status).toBe(404);
  proxy.unregister("s1");
  expect((await fetch(config.a!.url, { method: "POST", body: "{}" })).status).toBe(404);
});

test("mcpArgs passes the proxy config to the Host Session only when there are servers", () => {
  expect(mcpArgs(undefined)).toEqual([]);
  expect(mcpArgs({})).toEqual([]);
  expect(mcpArgs({ a: { type: "http", url: "http://127.0.0.1:1/s/a" } })).toEqual([
    "--mcp-config",
    '{"mcpServers":{"a":{"type":"http","url":"http://127.0.0.1:1/s/a"}}}',
  ]);
});
