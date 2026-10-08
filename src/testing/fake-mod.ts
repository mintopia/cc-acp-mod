import { request } from "node:http";
import { PROTOCOL_VERSION, type Command, type Hello, type ModEvent } from "../protocol.js";

export class FakeMod {
  readonly commands: Command[] = [];
  private stopped = false;
  private loop?: Promise<void>;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly socketPath: string, private readonly sessionId: string) {}

  async connect(hello: Partial<Hello> = {}): Promise<void> {
    await this.post("/hello", { protocolVersion: PROTOCOL_VERSION, sessionId: this.sessionId, modVersion: "fake", ...hello });
    this.loop = this.pollLoop();
  }

  async emit(...events: ModEvent[]): Promise<void> {
    await this.post("/events", { events });
  }

  async nextCommand(match: (c: Command) => boolean = () => true, timeoutMs = 2000): Promise<Command> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.commands.find(match);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`FakeMod: no matching command; saw ${JSON.stringify(this.commands)}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  }

  halt(): void {
    this.stopped = true;
  }

  async stop(): Promise<void> {
    this.halt();
    await this.loop;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const command = await this.call<Command>("GET", "/poll");
        if (command) {
          this.commands.push(command);
          for (const w of this.waiters.splice(0)) w();
        }
      } catch {
        if (!this.stopped) await new Promise((r) => setTimeout(r, 10));
      }
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    await this.call("POST", path, body);
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, method, path, headers: { "content-type": "application/json" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode === 204) return resolve(undefined);
          if (res.statusCode !== 200) return reject(new Error(`${method} ${path} -> ${res.statusCode}`));
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
        });
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
}
