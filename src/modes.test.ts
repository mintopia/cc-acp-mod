import { expect, test } from "vitest";
import { resolveModes, switchMode } from "./modes.js";

test("non-root with default settings offers all five modes", () => {
  const c = resolveModes([], {}, false);
  expect(c.availableModes).toEqual(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
  expect(c.initialMode).toBe("default");
});

test("bypass omitted for root unless IS_SANDBOX, or when disabled in settings", () => {
  expect(resolveModes([], {}, true).availableModes).not.toContain("bypassPermissions");
  expect(resolveModes([], { IS_SANDBOX: "1" }, true).availableModes).toContain("bypassPermissions");
  const disabled = [{ permissions: { disableBypassPermissionsMode: "disable" } }];
  expect(resolveModes(disabled, {}, false).bypassOffered).toBe(false);
});

test("initial mode comes from the last settings defaultMode and falls back when unavailable", () => {
  const s = (defaultMode: string) => ({ permissions: { defaultMode } });
  expect(resolveModes([s("plan"), s("acceptEdits")], {}, false).initialMode).toBe("acceptEdits");
  expect(resolveModes([s("bypassPermissions")], {}, true).initialMode).toBe("default");
  expect(resolveModes([s("dontAsk")], {}, false).initialMode).toBe("default");
});

function harness(cycle: string[], start: string) {
  let mode = start;
  let presses = 0;
  return {
    get presses() { return presses; },
    opts: {
      current: () => mode,
      pressShiftTab: async () => { presses++; mode = cycle[(cycle.indexOf(mode) + 1) % cycle.length]; },
      waitForChange: async () => mode,
    },
  };
}

test("switchMode presses until the Mod reports the target", async () => {
  const h = harness(["default", "acceptEdits", "plan"], "default");
  await switchMode({ ...h.opts, target: "plan" });
  expect(h.presses).toBe(2);
});

test("switchMode is a no-op when already in the target", async () => {
  const h = harness(["default", "plan"], "plan");
  await switchMode({ ...h.opts, target: "plan" });
  expect(h.presses).toBe(0);
});

test("switchMode fails after the press bound when the target is not in the cycle", async () => {
  const h = harness(["default", "acceptEdits"], "default");
  await expect(switchMode({ ...h.opts, target: "plan", maxPresses: 4 })).rejects.toThrow(/Could not reach/);
  expect(h.presses).toBe(4);
});

test("switchMode fails cleanly when the Mod stays silent", async () => {
  const h = harness(["default", "plan"], "default");
  await expect(switchMode({ ...h.opts, waitForChange: async () => undefined, target: "plan" })).rejects.toThrow(/did not report/);
});
