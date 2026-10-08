import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

export const run = promisify(execFile);

export const TMUX_SOCKET = "cc-acp";

const tmux = (...args: string[]) => run("tmux", ["-L", TMUX_SOCKET, ...args]);

export const sessionName = (sessionId: string) => `cc-acp-${sessionId}`;

const FORWARDED_ENV = /^(ANTHROPIC_|CLAUDE_|CC_ACP_|IS_SANDBOX$|MAX_THINKING_TOKENS$|HOME$|PATH$|XDG_RUNTIME_DIR$|TMPDIR$|LANG$|LC_)/;

export function forwardedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && FORWARDED_ENV.test(key)) out[key] = value;
  }
  return out;
}

export async function startSession(opts: {
  sessionId: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
}): Promise<void> {
  const envArgs = Object.entries(opts.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  await tmux(
    "new-session", "-d",
    "-s", sessionName(opts.sessionId),
    "-c", opts.cwd,
    "-x", "200", "-y", "50",
    ...envArgs,
    "--", ...opts.argv,
  );
}

export async function pressShiftTab(sessionId: string): Promise<void> {
  await tmux("send-keys", "-t", sessionName(sessionId), "BTab");
}

export async function typeCommand(sessionId: string, text: string): Promise<void> {
  const target = sessionName(sessionId);
  await tmux("send-keys", "-t", target, "-l", text);
  await sleep(200);
  await tmux("send-keys", "-t", target, "Enter");
}

export async function killSession(sessionId: string): Promise<void> {
  await tmux("kill-session", "-t", sessionName(sessionId)).catch(() => {});
}

export async function sendEnter(sessionId: string): Promise<void> {
  await tmux("send-keys", "-t", sessionName(sessionId), "Enter");
}

export async function hasSession(sessionId: string): Promise<boolean> {
  return tmux("has-session", "-t", `=${sessionName(sessionId)}`).then(
    () => true,
    () => false,
  );
}
