import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionChannel } from "./channel.js";
import type { HostMcpServer } from "./mcp-proxy.js";
import { checkClaudeVersion, checkTmux, trustDirectory } from "./launch.js";
import { socketDir, socketPath } from "./paths.js";
import { initialModelId } from "./models.js";
import type { Hello, ModEvent } from "./protocol.js";
import { readPermissionSettings, resolveModes, type ModeCatalogue } from "./modes.js";
import { forwardedEnv, hasSession, killSession, sendEnter, startSession } from "./tmux.js";

export const MOD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "mod");

export const MOD_PROBE_FILE = join(MOD_DIR, ".claude-plugin", "plugin.json");
export const MODE_PROBE_COMMAND = "cc-acp-probe-mode";
const STARTUP_TIMEOUT_MS = 60_000;
const REATTACH_TIMEOUT_MS = 15_000;
const BUFFERED_DRAIN_TIMEOUT_MS = 5_000;

export class ModeTracker {
  private waiters: Array<(mode: string) => void> = [];
  constructor(public current: string) {}

  update(mode: string): boolean {
    const changed = mode !== this.current;
    this.current = mode;
    for (const w of this.waiters.splice(0)) w(mode);
    return changed;
  }

  waitForReport(timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(undefined);
      }, timeoutMs);
      const done = (mode: string) => {
        clearTimeout(timer);
        resolve(mode);
      };
      this.waiters.push(done);
    });
  }
}

export interface HostSession {
  sessionId: string;
  channel: SessionChannel;
  steering: boolean;
  modes: ModeCatalogue;
  mode: ModeTracker;
}

export async function launchHostSession(opts: {
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  disallowedTools?: string[];
  mcpServers?: Record<string, HostMcpServer>;
  resume?: boolean;
  forkFrom?: string;
  onEvent: (event: ModEvent, mode: ModeTracker) => void;
  onDisplaced?: () => void;
  startupTimeoutMs?: number;
  reattachTimeoutMs?: number;
}): Promise<HostSession> {
  const env = opts.env ?? process.env;
  const executable = env.CLAUDE_CODE_EXECUTABLE || "claude";
  await checkTmux(env);
  await checkClaudeVersion(executable, env);
  await trustDirectory(opts.cwd, env);

  const modes = resolveModes(await readPermissionSettings(opts.cwd, env), env);
  const mode = new ModeTracker(modes.initialMode);
  const channel = new SessionChannel(socketPath(opts.sessionId, env));
  channel.onEvent = (event) => opts.onEvent(event, mode);
  channel.onDisplaced = opts.onDisplaced ?? (() => {});
  await channel.listen();

  if (opts.resume && !opts.forkFrom && (await hasSession(opts.sessionId))) {
    try {
      const hello = await channel.waitForHello(opts.reattachTimeoutMs ?? REATTACH_TIMEOUT_MS);
      await channel.waitForBuffered(BUFFERED_DRAIN_TIMEOUT_MS);
      return { sessionId: opts.sessionId, channel, steering: hello.steering === true, modes, mode };
    } catch {
      await killSession(opts.sessionId);
    }
  }

  const argv = [executable, "--plugin-dir", MOD_DIR, ...sessionArgs(opts)];
  argv.push("--permission-mode", modes.initialMode);
  if (modes.bypassOffered) argv.push("--allow-dangerously-skip-permissions");
  argv.push(...modelArgs(env));
  argv.push(...mcpArgs(opts.mcpServers));
  if (opts.disallowedTools?.length) argv.push("--disallowed-tools", opts.disallowedTools.join(","));

  let hello: Hello;
  try {
    await startSession({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      argv,
      env: { ...forwardedEnv(env), CC_ACP_SOCKET_DIR: socketDir(env), CC_ACP_PROBE_FILE: MOD_PROBE_FILE, CC_ACP_PROBE_COMMAND: MODE_PROBE_COMMAND },
    });
    hello = await channel.waitForHello(opts.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
  } catch (err) {
    await killSession(opts.sessionId);
    await channel.close();
    throw new Error(
      `Host Session failed to start: ${(err as Error).message}. ` +
        `Likely cause: a startup dialog blocked Claude Code or the Mod failed to load.`,
    );
  }
  return { sessionId: opts.sessionId, channel, steering: hello.steering === true, modes, mode };
}

export async function stopHostSession(host: HostSession): Promise<void> {
  await killSession(host.sessionId);
  await host.channel.close();
}

export function sessionArgs(opts: { sessionId: string; resume?: boolean; forkFrom?: string }): string[] {
  if (opts.forkFrom) return ["--resume", opts.forkFrom, "--fork-session", "--session-id", opts.sessionId];
  return [opts.resume ? "--resume" : "--session-id", opts.sessionId];
}

export function modelArgs(env: NodeJS.ProcessEnv): string[] {
  const id = initialModelId(env);
  return id === "default" ? [] : ["--model", id];
}

export function mcpArgs(servers: Record<string, HostMcpServer> | undefined): string[] {
  return servers && Object.keys(servers).length ? ["--mcp-config", JSON.stringify({ mcpServers: servers })] : [];
}

const CONFIRM_AFTER_MS = 1_000;
const SET_MODEL_TIMEOUT_MS = 30_000;

/** `/model` mid-conversation opens a confirmation dialog the Mod cannot dismiss, so press Enter until the Mod reports the change. */
export async function switchModel(
  host: Pick<HostSession, "sessionId"> & { channel: Pick<HostSession["channel"], "send"> },
  id: string,
  changed: Promise<unknown>,
): Promise<void> {
  host.channel.send({ type: "set_model", id });
  const deadline = Date.now() + SET_MODEL_TIMEOUT_MS;
  let done = false;
  void changed.then(() => (done = true));
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CONFIRM_AFTER_MS));
    if (!done) await sendEnter(host.sessionId).catch(() => {});
  }
  if (!done) throw new Error(`Model did not switch to ${id}`);
}
