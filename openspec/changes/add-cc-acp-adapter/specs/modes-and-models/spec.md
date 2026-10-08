## ADDED Requirements

### Requirement: Mode catalogue
The Adapter SHALL expose modes `default`, `acceptEdits`, `plan`, `auto` and `bypassPermissions` in `session/new` and `session/load` responses, offering `bypassPermissions` only under the Reference Adapter's conditions (not root unless `IS_SANDBOX`, not disabled in settings).

#### Scenario: Harmonic requirements
- **WHEN** a session is created as a non-root user with default settings
- **THEN** `availableModes` includes `auto` and `bypassPermissions`

### Requirement: Initial mode
The Host Session SHALL launch with `--permission-mode` set to the user's `permissions.defaultMode` (falling back to `default`), plus `--allow-dangerously-skip-permissions` when `bypassPermissions` is offered.

#### Scenario: Default mode from settings
- **WHEN** user settings set `permissions.defaultMode: acceptEdits`
- **THEN** the session's `currentModeId` is `acceptEdits`

### Requirement: Switching modes
`session/set_mode` SHALL switch the Host Session's permission mode by sending Shift+Tab via `tmux send-keys` until the Mod reports the target mode, and SHALL emit `current_mode_update`. Mode changes made inside the session (e.g. EnterPlanMode) SHALL also emit `current_mode_update`.

#### Scenario: Switch to plan
- **WHEN** the Client calls `session/set_mode` with `plan`
- **THEN** the Host Session ends in plan mode, the call succeeds, and `current_mode_update` reports `plan`

### Requirement: Models
The Adapter SHALL offer a model list built from a built-in catalogue plus `CLAUDE_MODEL_CONFIG`, respect `ANTHROPIC_MODEL`, and implement `session/set_model` (and the `model` config option) via `$.command.run('model', id)`.

#### Scenario: Switch model
- **WHEN** the Client calls `session/set_model` with a listed model id
- **THEN** subsequent turns use that model and the change is reported to the Client

### Requirement: Effort and fast options (Tier 2)
The Adapter SHALL expose `effort` and `fast` config options matching the Reference Adapter where the Host Session can apply them.

#### Scenario: Set effort
- **WHEN** the Client sets `effort` to `high`
- **THEN** the Host Session applies it and `config_option_update` reflects it
