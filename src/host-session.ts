import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionChannel } from "./channel.js";
import { checkClaudeVersion, checkTmux, trustDirectory } from "./launch.js";
import { socketDir, socketPath } from "./paths.js";
import { initialModelId } from "./models.js";
import type { ModEvent } from "./protocol.js";
import { forwardedEnv, killSession, sendEnter, startSession } from "./tmux.js";

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
  argv.push(...modelArgs(env));

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

export function modelArgs(env: NodeJS.ProcessEnv): string[] {
  const id = initialModelId(env);
  return id === "default" ? [] : ["--model", id];
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
