import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { json } from "node:stream/consumers";
import { POLL_WINDOW_MS, type Command, type Hello, type ModEvent, type PermissionDecision } from "./protocol.js";

const OWNERSHIP_CHECK_MS = 500;

export function waitFor<T>(waiters: Array<(value: T) => void>, timeoutMs: number, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    const done = (value: T) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(done), 1);
      resolve(onTimeout);
    }, timeoutMs);
    waiters.push(done);
  });
}

type Waiter = { resolve: (cmd: Command | null) => void; timer: NodeJS.Timeout };

export class SessionChannel {
  private server?: Server;
  private helloResolve!: (hello: Hello) => void;
  private helloPromise: Promise<Hello>;
  private turnActive = false;
  private readonly idleWaiters: Array<(idle: boolean) => void> = [];
  private readonly commands: Command[] = [];
  private waiter?: Waiter;
  private readonly answers = new Map<string, PermissionDecision>();
  private readonly answerWaiters = new Map<string, { resolve: (d: PermissionDecision | null) => void; timer: NodeJS.Timeout }>();
  onEvent: (event: ModEvent) => void = () => {};
  onDisplaced: () => void = () => {};
  private inode?: number;
  private watcher?: NodeJS.Timeout;
  private displaced = false;
  private helloed = false;
  private buffered = 0;
  private received = 0;
  private readonly bufferedWaiters: Array<(value: void) => void> = [];

  constructor(readonly path: string, private readonly pollWindowMs = POLL_WINDOW_MS) {
    this.helloPromise = new Promise((resolve) => (this.helloResolve = resolve));
  }

  expectHello(): void {
    this.helloed = false;
    this.helloPromise = new Promise((resolve) => (this.helloResolve = resolve));
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!this.turnActive) return Promise.resolve(true);
    return waitFor(this.idleWaiters, timeoutMs, false);
  }

  private trackTurn(event: ModEvent): void {
    if (event.type === "turn_started") this.turnActive = true;
    if (event.type !== "turn_completed") return;
    this.turnActive = false;
    for (const done of this.idleWaiters.splice(0)) done(true);
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
    this.inode = (await stat(this.path)).ino;
    this.watcher = setInterval(() => void this.checkOwnership(), OWNERSHIP_CHECK_MS);
    this.watcher.unref();
  }

  private async checkOwnership(): Promise<void> {
    const current = await stat(this.path).then((s) => s.ino, () => undefined);
    if (current === undefined || current === this.inode || this.displaced) return;
    this.displaced = true;
    clearInterval(this.watcher);
    this.onDisplaced();
  }

  waitForBuffered(timeoutMs: number): Promise<void> {
    if (this.received >= this.buffered) return Promise.resolve();
    return waitFor(this.bufferedWaiters, timeoutMs, undefined);
  }

  private countEvents(n: number): void {
    this.received += n;
    if (this.received < this.buffered) return;
    for (const done of this.bufferedWaiters.splice(0)) done();
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
    clearInterval(this.watcher);
    for (const done of this.bufferedWaiters.splice(0)) done();
    this.turnActive = false;
    for (const done of this.idleWaiters.splice(0)) done(true);
    for (const { resolve, timer } of this.answerWaiters.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    this.answerWaiters.clear();
    this.waiter?.resolve(null);
    if (this.waiter) clearTimeout(this.waiter.timer);
    this.waiter = undefined;
    if (this.displaced) {
      this.server?.unref();
      return;
    }
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await rm(this.path, { force: true });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.helloed && req.url !== "/hello") return reply(res, 409);
      if (req.method === "POST" && req.url === "/hello") {
        const hello = await json(req) as Hello;
        this.turnActive = hello.busy === true;
        if (!this.turnActive) for (const done of this.idleWaiters.splice(0)) done(true);
        this.buffered = hello.buffered ?? 0;
        this.received = 0;
        this.helloed = true;
        this.helloResolve(hello);
        return reply(res, 204);
      }
      if (req.method === "POST" && req.url === "/events") {
        const { events } = await json(req) as { events: ModEvent[] };
        for (const event of events) {
          this.trackTurn(event);
          this.onEvent(event);
        }
        this.countEvents(events.length);
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
