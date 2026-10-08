import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { claudeConfigDir } from "./paths.js";

export const MODE_IDS = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
export type ModeId = (typeof MODE_IDS)[number];

const MODE_INFO: Record<ModeId, { name: string; description: string }> = {
  default: { name: "Default", description: "Standard behavior, prompts for dangerous operations" },
  acceptEdits: { name: "Accept Edits", description: "Auto-accept file edit operations" },
  plan: { name: "Plan Mode", description: "Planning mode, no actual tool execution" },
  auto: { name: "Auto", description: "Use a model classifier to approve or deny permission prompts" },
  bypassPermissions: { name: "Bypass Permissions", description: "Bypass all permission checks" },
};

export const MAX_MODE_PRESSES = 8;

interface PermissionSettings {
  permissions?: { defaultMode?: string; disableBypassPermissionsMode?: string };
}

export async function readPermissionSettings(cwd: string, env: NodeJS.ProcessEnv): Promise<PermissionSettings[]> {
  const files = [
    join(claudeConfigDir(env), "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ];
  const out: PermissionSettings[] = [];
  for (const file of files) {
    try {
      out.push(JSON.parse(await readFile(file, "utf8")));
    } catch {}
  }
  return out;
}

export interface ModeCatalogue {
  availableModes: ModeId[];
  initialMode: ModeId;
  bypassOffered: boolean;
}

export function resolveModes(
  settings: PermissionSettings[],
  env: NodeJS.ProcessEnv,
  isRoot = process.getuid?.() === 0,
): ModeCatalogue {
  const bypassDisabled = settings.some((s) => s.permissions?.disableBypassPermissionsMode === "disable");
  const bypassOffered = !bypassDisabled && (!isRoot || Boolean(env.IS_SANDBOX));
  const availableModes = MODE_IDS.filter((m) => m !== "bypassPermissions" || bypassOffered);
  const configured = settings.map((s) => s.permissions?.defaultMode).filter(Boolean).at(-1);
  const initialMode = availableModes.find((m) => m === configured) ?? "default";
  return { availableModes, initialMode, bypassOffered };
}

export function toAcpModeState(catalogue: ModeCatalogue, currentModeId: string): acp.SessionModeState {
  return {
    currentModeId,
    availableModes: catalogue.availableModes.map((id) => ({ id, ...MODE_INFO[id] })),
  };
}

export async function switchMode(opts: {
  target: string;
  current: () => string;
  pressShiftTab: () => Promise<void>;
  waitForChange: (previous: string) => Promise<string | undefined>;
  maxPresses?: number;
}): Promise<string> {
  const max = opts.maxPresses ?? MAX_MODE_PRESSES;
  for (let presses = 0; opts.current() !== opts.target; presses++) {
    if (presses >= max) {
      throw new Error(`Could not reach mode "${opts.target}" after ${max} presses; still in "${opts.current()}"`);
    }
    const before = opts.current();
    await opts.pressShiftTab();
    if ((await opts.waitForChange(before)) === undefined) {
      throw new Error(`Mod did not report a mode change after Shift+Tab; still in "${opts.current()}"`);
    }
  }
  return opts.target;
}
