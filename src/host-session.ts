import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionChannel } from "./channel.js";
import { checkClaudeVersion, checkTmux, trustDirectory } from "./launch.js";
import { socketDir, socketPath } from "./paths.js";
import type { ModEvent } from "./protocol.js";
import { readPermissionSettings, resolveModes, type ModeCatalogue } from "./modes.js";
import { forwardedEnv, killSession, startSession } from "./tmux.js";

export const MOD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "mod");

export const MOD_PROBE_FILE = join(MOD_DIR, ".claude-plugin", "plugin.json");
export const MODE_PROBE_COMMAND = "cc-acp-probe-mode";
const STARTUP_TIMEOUT_MS = 60_000;

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
  modes: ModeCatalogue;
  mode: ModeTracker;
}

export async function launchHostSession(opts: {
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onEvent: (event: ModEvent, mode: ModeTracker) => void;
  startupTimeoutMs?: number;
}): Promise<HostSession> {
  const env = opts.env ?? process.env;
  const executable = env.CLAUDE_CODE_EXECUTABLE || "claude";
  await checkTmux();
  await checkClaudeVersion(executable);
  await trustDirectory(opts.cwd, env);

  const modes = resolveModes(await readPermissionSettings(opts.cwd, env), env);
  const mode = new ModeTracker(modes.initialMode);
  const channel = new SessionChannel(socketPath(opts.sessionId, env));
  channel.onEvent = (event) => opts.onEvent(event, mode);
  await channel.listen();

  const argv = [executable, "--plugin-dir", MOD_DIR, "--session-id", opts.sessionId];
  argv.push("--permission-mode", modes.initialMode);
  if (modes.bypassOffered) argv.push("--allow-dangerously-skip-permissions");
  if (env.ANTHROPIC_MODEL) argv.push("--model", env.ANTHROPIC_MODEL);

  try {
    await startSession({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      argv,
      env: { ...forwardedEnv(env), CC_ACP_SOCKET_DIR: socketDir(env), CC_ACP_PROBE_FILE: MOD_PROBE_FILE, CC_ACP_PROBE_COMMAND: MODE_PROBE_COMMAND },
    });
    await channel.waitForHello(opts.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
  } catch (err) {
    await killSession(opts.sessionId);
    await channel.close();
    throw new Error(
      `Host Session failed to start: ${(err as Error).message}. ` +
        `Likely cause: a startup dialog blocked Claude Code or the Mod failed to load.`,
    );
  }
  return { sessionId: opts.sessionId, channel, modes, mode };
}

export async function stopHostSession(host: HostSession): Promise<void> {
  await killSession(host.sessionId);
  await host.channel.close();
}
