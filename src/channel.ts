import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { POLL_WINDOW_MS, type Command, type Hello, type ModEvent, type PermissionDecision } from "./protocol.js";

type Waiter = { resolve: (cmd: Command | null) => void; timer: NodeJS.Timeout };

export class SessionChannel {
  private server?: Server;
  private helloResolve!: (hello: Hello) => void;
  private readonly helloPromise: Promise<Hello>;
  private readonly commands: Command[] = [];
  private waiter?: Waiter;
  private readonly answers = new Map<string, PermissionDecision>();
  private readonly answerWaiters = new Map<string, { resolve: (d: PermissionDecision | null) => void; timer: NodeJS.Timeout }>();
  onEvent: (event: ModEvent) => void = () => {};

  constructor(readonly path: string, private readonly pollWindowMs = POLL_WINDOW_MS) {
    this.helloPromise = new Promise((resolve) => (this.helloResolve = resolve));
  }

  async listen(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await rm(this.path, { force: true });
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.path, resolve);
    });
    await chmod(this.path, 0o600);
  }

  waitForHello(timeoutMs: number): Promise<Hello> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Mod did not connect within ${timeoutMs}ms`)), timeoutMs);
      this.helloPromise.then(
        (hello) => {
          clearTimeout(timer);
          resolve(hello);
        },
        reject,
      );
    });
  }

  send(command: Command): void {
    if (this.waiter) {
      const { resolve, timer } = this.waiter;
      this.waiter = undefined;
      clearTimeout(timer);
      resolve(command);
    } else {
      this.commands.push(command);
    }
  }

  answerPermission(requestId: string, decision: PermissionDecision): void {
    const waiting = this.answerWaiters.get(requestId);
    if (waiting) {
      this.answerWaiters.delete(requestId);
      clearTimeout(waiting.timer);
      waiting.resolve(decision);
    } else {
      this.answers.set(requestId, decision);
    }
  }

  async close(): Promise<void> {
    for (const { resolve, timer } of this.answerWaiters.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    this.answerWaiters.clear();
    this.waiter?.resolve(null);
    if (this.waiter) clearTimeout(this.waiter.timer);
    this.waiter = undefined;
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await rm(this.path, { force: true });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === "POST" && req.url === "/hello") {
        this.helloResolve(await readJson<Hello>(req));
        return reply(res, 204);
      }
      if (req.method === "POST" && req.url === "/events") {
        const { events } = await readJson<{ events: ModEvent[] }>(req);
        for (const event of events) this.onEvent(event);
        return reply(res, 204);
      }
      if (req.method === "GET" && req.url === "/poll") {
        const command = await this.nextCommand();
        return command ? reply(res, 200, command) : reply(res, 204);
      }
      if (req.method === "GET" && req.url?.startsWith("/permission?")) {
        const requestId = new URL(req.url, "http://adapter").searchParams.get("id") ?? "";
        const decision = await this.nextAnswer(requestId);
        return decision ? reply(res, 200, { decision }) : reply(res, 204);
      }
      reply(res, 404);
    } catch {
      reply(res, 400);
    }
  }

  private nextAnswer(requestId: string): Promise<PermissionDecision | null> {
    const ready = this.answers.get(requestId);
    if (ready) {
      this.answers.delete(requestId);
      return Promise.resolve(ready);
    }
    const previous = this.answerWaiters.get(requestId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.answerWaiters.delete(requestId);
        resolve(null);
      }, this.pollWindowMs);
      this.answerWaiters.set(requestId, { resolve, timer });
    });
  }

  private nextCommand(): Promise<Command | null> {
    const queued = this.commands.shift();
    if (queued) return Promise.resolve(queued);
    this.waiter?.resolve(null);
    if (this.waiter) clearTimeout(this.waiter.timer);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        resolve(null);
      }, this.pollWindowMs);
      this.waiter = { resolve, timer };
    });
  }
}

function reply(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
  } else {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
