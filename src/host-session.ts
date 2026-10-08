import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionChannel } from "./channel.js";
import type { HostMcpServer } from "./mcp-proxy.js";
import { checkClaudeVersion, checkTmux, trustDirectory } from "./launch.js";
import { socketDir, socketPath } from "./paths.js";
import { initialModelId } from "./models.js";
import type { Hello, ModEvent } from "./protocol.js";
import { forwardedEnv, killSession, sendEnter, startSession } from "./tmux.js";

export const MOD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "mod");

const STARTUP_TIMEOUT_MS = 60_000;

export interface HostSession {
  sessionId: string;
  channel: SessionChannel;
  steering: boolean;
}

export async function launchHostSession(opts: {
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  disallowedTools?: string[];
  mcpServers?: Record<string, HostMcpServer>;
  resume?: boolean;
  forkFrom?: string;
  onEvent: (event: ModEvent) => void;
  startupTimeoutMs?: number;
}): Promise<HostSession> {
  const env = opts.env ?? process.env;
  const executable = env.CLAUDE_CODE_EXECUTABLE || "claude";
  await checkTmux(env);
  await checkClaudeVersion(executable, env);
  await trustDirectory(opts.cwd, env);

  const channel = new SessionChannel(socketPath(opts.sessionId, env));
  channel.onEvent = opts.onEvent;
  await channel.listen();

  const argv = [executable, "--plugin-dir", MOD_DIR, ...sessionArgs(opts)];
  argv.push(...modelArgs(env));
  argv.push(...mcpArgs(opts.mcpServers));
  if (opts.disallowedTools?.length) argv.push("--disallowed-tools", opts.disallowedTools.join(","));

  let hello: Hello;
  try {
    await startSession({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      argv,
      env: { ...forwardedEnv(env), CC_ACP_SOCKET_DIR: socketDir(env) },
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
  return { sessionId: opts.sessionId, channel, steering: hello.steering === true };
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
