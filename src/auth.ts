import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function claudeLoggedIn(executable = "claude", env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const { stdout } = await run(executable, ["auth", "status"], { env });
    return (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    return false;
  }
}

export function terminalAuthMethods(executable = "claude"): Array<Record<string, unknown>> {
  const method = (id: string, name: string, description: string, args: string[]) => ({
    id,
    name,
    description,
    _meta: { "terminal-auth": { command: executable, args, label: name } },
  });
  return [
    method("claude-login", "Log in with Claude", "Log in with your Claude subscription", ["auth", "login", "--claudeai"]),
    method("claude-console-login", "Log in with Anthropic Console", "Log in with an Anthropic Console account (API billing)", [
      "auth",
      "login",
      "--console",
    ]),
  ];
}
