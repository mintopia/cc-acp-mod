## ADDED Requirements

### Requirement: Drop-in npm package
The project SHALL publish an npm package `cc-acp` whose `cc-acp` binary is the Adapter and which bundles the Mod, so Clients switch by changing their command to `npx --yes cc-acp` and users install nothing into `~/.claude`.

#### Scenario: Harmonic switch
- **WHEN** Harmonic's Claude harness command is set to `npx --yes cc-acp`
- **THEN** Harmonic conversations work without other configuration changes

### Requirement: Reference Adapter compatible configuration
The Adapter SHALL honour the Reference Adapter's environment variables and flags where meaningful: `CLAUDE_CODE_EXECUTABLE`, `ANTHROPIC_MODEL`, `CLAUDE_MODEL_CONFIG`, `CLAUDE_CONFIG_DIR`, `MAX_THINKING_TOKENS`, `IS_SANDBOX`, `--version`.

#### Scenario: Custom executable
- **WHEN** `CLAUDE_CODE_EXECUTABLE` points to a claude binary
- **THEN** Host Sessions launch that binary

### Requirement: Platforms
The Adapter SHALL support Linux and macOS with tmux installed, and Windows only via WSL.

#### Scenario: tmux missing
- **WHEN** tmux is not installed
- **THEN** `session/new` fails with an error saying tmux is required
