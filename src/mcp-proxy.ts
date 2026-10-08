import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import type * as acp from "@agentclientprotocol/sdk";

export const DISCONNECTED_MESSAGE = "Client disconnected: the MCP server is unavailable until a Client attaches to this session";

const JSONRPC_SERVER_ERROR = -32000;

type JsonRpc = { jsonrpc?: string; id?: number | string | null; method?: string; result?: unknown; error?: unknown };

interface Bridge {
  send(message: JsonRpc): Promise<JsonRpc | undefined>;
  close(reason: Error): void;
}

interface Endpoint {
  upstream: acp.McpServer | null;
  bridge?: Bridge;
  aborts: Set<AbortController>;
}

export interface HostMcpServer {
  type: "http";
  url: string;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "content-length", "host"]);
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];

function headerMap(headers: acp.HttpHeader[]): Record<string, string> {
  return Object.fromEntries(headers.map((h) => [h.name, h.value]));
}

function errorResponse(id: JsonRpc["id"], message: string): JsonRpc {
  return { jsonrpc: "2.0", id: id ?? null, error: { code: JSONRPC_SERVER_ERROR, message } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class Pending {
  private readonly waiting = new Map<number | string, { resolve: (m: JsonRpc) => void; reject: (e: Error) => void }>();

  wait(id: number | string): Promise<JsonRpc> {
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }

  settle(message: JsonRpc): void {
    if (message.id === undefined || message.id === null || message.method) return;
    const entry = this.waiting.get(message.id);
    this.waiting.delete(message.id);
    entry?.resolve(message);
  }

  rejectAll(reason: Error): void {
    for (const entry of this.waiting.values()) entry.reject(reason);
    this.waiting.clear();
  }
}

class StdioBridge implements Bridge {
  private readonly pending = new Pending();
  private readonly child;
  private closed?: Error;

  constructor(server: acp.McpServerStdio) {
    this.child = spawn(server.command, server.args, {
      env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.pending.settle(JSON.parse(line) as JsonRpc);
      } catch {}
    });
    this.child.on("error", (err) => this.fail(err));
    this.child.on("exit", (code) => this.fail(new Error(`MCP server process exited (${code})`)));
    this.child.stdin.on("error", () => {});
  }

  private fail(err: Error): void {
    this.closed ??= err;
    this.pending.rejectAll(this.closed);
  }

  async send(message: JsonRpc): Promise<JsonRpc | undefined> {
    if (this.closed) throw this.closed;
    const reply = message.id !== undefined && message.id !== null && message.method ? this.pending.wait(message.id) : undefined;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return reply;
  }

  close(reason: Error): void {
    this.fail(reason);
    this.child.kill();
  }
}

/** Legacy HTTP+SSE transport: a long-lived GET stream carries responses, an announced endpoint receives POSTs. */
class SseBridge implements Bridge {
  private readonly pending = new Pending();
  private readonly abort = new AbortController();
  private readonly endpoint: Promise<string>;
  private closed?: Error;

  constructor(private readonly server: acp.McpServerSse) {
    let resolveEndpoint!: (url: string) => void;
    let rejectEndpoint!: (err: Error) => void;
    this.endpoint = new Promise((resolve, reject) => {
      resolveEndpoint = resolve;
      rejectEndpoint = reject;
    });
    this.endpoint.catch(() => {});
    void this.listen(resolveEndpoint).catch((err: Error) => {
      rejectEndpoint(err);
      this.fail(err);
    });
  }

  private async listen(onEndpoint: (url: string) => void): Promise<void> {
    const res = await fetch(this.server.url, {
      headers: { ...headerMap(this.server.headers), accept: "text/event-stream" },
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`SSE MCP server responded ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        const payload = data.join("\n");
        if (event === "endpoint") onEndpoint(new URL(payload, this.server.url).toString());
        else if (event === "message") {
          try {
            this.pending.settle(JSON.parse(payload) as JsonRpc);
          } catch {}
        }
      }
    }
    throw new Error("SSE MCP server closed its event stream");
  }

  private fail(err: Error): void {
    this.closed ??= err;
    this.pending.rejectAll(this.closed);
  }

  async send(message: JsonRpc): Promise<JsonRpc | undefined> {
    const endpoint = await this.endpoint;
    if (this.closed) throw this.closed;
    const reply = message.id !== undefined && message.id !== null && message.method ? this.pending.wait(message.id) : undefined;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { ...headerMap(this.server.headers), "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      const err = new Error(`SSE MCP server rejected the message with ${res.status}`);
      if (message.id !== undefined && message.id !== null) this.pending.settle(errorResponse(message.id, err.message));
      else throw err;
    }
    return reply;
  }

  close(reason: Error): void {
    this.fail(reason);
    this.abort.abort();
  }
}

/** One loopback HTTP server fronting every Client MCP server of every Host Session, so the Host Session's MCP config never has to change. */
export class McpProxy {
  private server?: Server;
  private port = 0;
  private readonly endpoints = new Map<string, Endpoint>();

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    this.port = (this.server.address() as { port: number }).port;
  }

  /** Registers the session's server names and returns the config the Host Session should be launched with. */
  register(sessionId: string, names: string[]): Record<string, HostMcpServer> {
    const config: Record<string, HostMcpServer> = {};
    for (const name of names) {
      this.endpoints.set(key(sessionId, name), { upstream: null, aborts: new Set() });
      config[name] = { type: "http", url: `http://127.0.0.1:${this.port}/${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}` };
    }
    return config;
  }

  /** Points registered endpoints at the servers the attached Client supplied; null marks the session detached. */
  setClient(sessionId: string, servers: acp.McpServer[] | null): void {
    const reason = new Error(DISCONNECTED_MESSAGE);
    for (const [k, endpoint] of this.endpoints) {
      if (!k.startsWith(`${encodeURIComponent(sessionId)}/`)) continue;
      const name = decodeURIComponent(k.slice(k.indexOf("/") + 1));
      endpoint.bridge?.close(reason);
      endpoint.bridge = undefined;
      for (const abort of endpoint.aborts) abort.abort(reason);
      endpoint.upstream = servers?.find((s) => s.name === name) ?? null;
    }
  }

  unregister(sessionId: string): void {
    this.setClient(sessionId, null);
    for (const k of [...this.endpoints.keys()]) if (k.startsWith(`${encodeURIComponent(sessionId)}/`)) this.endpoints.delete(k);
  }

  async close(): Promise<void> {
    for (const k of [...this.endpoints.keys()]) this.unregister(decodeURIComponent(k.slice(0, k.indexOf("/"))));
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/([^/]+)\/([^/?]+)/.exec(req.url ?? "");
    const endpoint = match && this.endpoints.get(`${match[1]}/${match[2]}`);
    if (!endpoint) return void res.writeHead(404).end();
    try {
      await this.forward(endpoint, req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end((err as Error).message);
    }
  }

  private async forward(endpoint: Endpoint, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const message = body ? (JSON.parse(body) as JsonRpc) : undefined;
    const upstream = endpoint.upstream;
    if (!upstream) return void replyDetached(res, message);
    if ("type" in upstream && upstream.type === "acp") {
      return void replyError(res, message, "ACP-transport MCP servers are not supported");
    }
    if ("type" in upstream && upstream.type === "http") return this.forwardHttp(endpoint, upstream, req, res, body);

    if (!message) return void res.writeHead(405).end();
    endpoint.bridge ??= "type" in upstream && upstream.type === "sse" ? new SseBridge(upstream) : new StdioBridge(upstream as acp.McpServerStdio);
    try {
      const reply = await endpoint.bridge.send(message);
      if (!reply) return void res.writeHead(202).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    } catch (err) {
      replyError(res, message, (err as Error).message);
    }
  }

  private async forwardHttp(
    endpoint: Endpoint,
    upstream: acp.McpServerHttp,
    req: IncomingMessage,
    res: ServerResponse,
    body: string | undefined,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    Object.assign(headers, headerMap(upstream.headers));

    const abort = new AbortController();
    endpoint.aborts.add(abort);
    res.on("close", () => abort.abort());
    try {
      const message = body ? (JSON.parse(body) as JsonRpc) : undefined;
      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(upstream.url, { method: req.method, headers, body, signal: abort.signal });
      } catch (err) {
        if (endpoint.upstream !== upstream) return void replyDetached(res, message);
        throw err;
      }
      const out: Record<string, string> = {};
      upstreamRes.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name) && name !== "content-encoding") out[name] = value;
      });
      res.writeHead(upstreamRes.status, out);
      if (!upstreamRes.body) return void res.end();
      try {
        for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      } catch {}
      res.end();
    } finally {
      endpoint.aborts.delete(abort);
    }
  }
}

function key(sessionId: string, name: string): string {
  return `${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}`;
}

function replyError(res: ServerResponse, message: JsonRpc | undefined, text: string): void {
  if (message?.id === undefined || message.id === null) return void res.writeHead(503, { "content-type": "text/plain" }).end(text);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(errorResponse(message.id, text)));
}

function replyDetached(res: ServerResponse, message: JsonRpc | undefined): void {
  if (res.headersSent) return void res.end();
  replyError(res, message, DISCONNECTED_MESSAGE);
}
