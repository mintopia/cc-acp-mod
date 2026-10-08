import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function socketDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR || env.TMPDIR || tmpdir();
  return join(base, "cc-acp");
}

export function socketPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(socketDir(env), `${sessionId}.sock`);
}

export function claudeConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
}
