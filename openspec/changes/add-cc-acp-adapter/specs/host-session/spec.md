## ADDED Requirements

### Requirement: Launch Host Session per ACP session
On `session/new` the Adapter SHALL launch an interactive `claude` in a detached tmux session on the dedicated socket `tmux -L cc-acp`, named `cc-acp-<sessionId>`, with cwd set to the requested cwd and the bundled Mod loaded via `--plugin-dir`.

#### Scenario: New session
- **WHEN** a Client calls `session/new` with a cwd
- **THEN** a tmux session `cc-acp-<sessionId>` exists on socket `cc-acp` running `claude` in that cwd, and the Mod connects to the Adapter before `session/new` returns

#### Scenario: Debuggable by a human
- **WHEN** an operator runs `tmux -L cc-acp attach -t cc-acp-<sessionId>`
- **THEN** they see the live Host Session

### Requirement: Unattended launch preparation
Before launching, the Adapter SHALL mark only the requested cwd as trusted in `~/.claude.json`, and SHALL fail `session/new` with a clear error if any other dialog blocks startup.

#### Scenario: New directory
- **WHEN** the requested cwd has never been trusted
- **THEN** the Adapter records trust for exactly that directory and the launch proceeds without a trust dialog

#### Scenario: Blocked startup
- **WHEN** the Mod does not connect within the startup timeout
- **THEN** `session/new` fails with an error describing the likely cause and the tmux session is killed

### Requirement: Minimum Claude Code version
The Adapter SHALL check `claude --version` against a minimum supported version before launching and SHALL fail clearly when it is older. There is no maximum version.

#### Scenario: Old CLI
- **WHEN** the installed Claude Code is older than the minimum
- **THEN** `session/new` fails with an error naming the installed and required versions

### Requirement: Host Sessions outlive the Adapter
A Host Session SHALL keep running when its Adapter or Client disconnects.

#### Scenario: Adapter exits mid-turn
- **WHEN** the Adapter process exits while a turn is running
- **THEN** the Host Session continues the turn and the Mod buffers its events

### Requirement: Reattach and Revive on load
On `session/load` (and `session/resume`), the Adapter SHALL Reattach to a live Host Session or, if none is running, Revive one with `claude --resume <sessionId>` in a new tmux session.

#### Scenario: Reattach to live session
- **WHEN** `session/load` targets a session whose Host Session is running with a matching Mod protocol version
- **THEN** the Adapter replays the transcript, then the Mod's buffered events for the in-flight turn, then returns the load response

#### Scenario: Revive gone session
- **WHEN** `session/load` targets a session with no running Host Session
- **THEN** the Adapter replays the transcript and starts a new Host Session resuming that session id

### Requirement: Single Owner per Host Session
Exactly one Adapter SHALL be the Owner of a Host Session; a newer claim SHALL displace the previous Owner.

#### Scenario: Zombie Adapter
- **WHEN** a second Adapter loads a session another Adapter owns
- **THEN** the second Adapter becomes Owner and the previous Owner ends its ACP session with an error

### Requirement: Mod version skew
On connect the Adapter and Mod SHALL exchange protocol versions; on mismatch the Adapter SHALL wait until the Host Session is idle and then Revive it with the current Mod.

#### Scenario: Upgrade while session lives
- **WHEN** a newer Adapter Reattaches to a Host Session running an older Mod protocol
- **THEN** once idle the Host Session is replaced by a Revived one running the current Mod, preserving the transcript

### Requirement: Idle reaping
A Host Session with no Owner SHALL be killed after an idle timeout (default 1 hour, configurable). A Host Session that is mid-turn or awaiting a permission answer SHALL NOT count as idle.

#### Scenario: Reaped then resumed
- **WHEN** an unowned idle Host Session exceeds the timeout
- **THEN** it is killed, and a later `session/load` with its id Revives it
