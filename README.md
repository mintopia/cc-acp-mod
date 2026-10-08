# CC ACP Mod

A mod for Claude Code to implement ACP support.


## Configuration

- `CC_ACP_IDLE_TIMEOUT_MS`: how long a Host Session with no Owner may sit idle before it is killed and its socket removed. Default `3600000` (1 hour); `0` disables reaping. Sessions mid-turn or awaiting a permission or question answer are never reaped, and a reaped session can be Revived with `session/load`.
