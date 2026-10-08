import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionChannel } from "./channel.js";
import { checkClaudeVersion, checkTmux, trustDirectory } from "./launch.js";
import { socketDir, socketPath } from "./paths.js";
import type { ModEvent } from "./protocol.js";
import { forwardedEnv, killSession, startSession } from "./tmux.js";

export const MOD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "mod");

const STARTUP_TIMEOUT_MS = 60_000;

export interface HostSession {
  sessionId: string;
  channel: SessionChannel;
}

export async function launchHostSession(opts: {
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onEvent: (event: ModEvent) => void;
  startupTimeoutMs?: number;
}): Promise<HostSession> {
  const env = opts.env ?? process.env;
  const executable = env.CLAUDE_CODE_EXECUTABLE || "claude";
  await checkTmux();
  await checkClaudeVersion(executable);
  await trustDirectory(opts.cwd, env);

  const channel = new SessionChannel(socketPath(opts.sessionId, env));
  channel.onEvent = opts.onEvent;
  await channel.listen();

  const argv = [executable, "--plugin-dir", MOD_DIR, "--session-id", opts.sessionId];
  if (env.ANTHROPIC_MODEL) argv.push("--model", env.ANTHROPIC_MODEL);

  try {
    await startSession({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      argv,
      env: { ...forwardedEnv(env), CC_ACP_SOCKET_DIR: socketDir(env) },
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
  return { sessionId: opts.sessionId, channel };
}

export async function stopHostSession(host: HostSession): Promise<void> {
  await killSession(host.sessionId);
  await host.channel.close();
}
