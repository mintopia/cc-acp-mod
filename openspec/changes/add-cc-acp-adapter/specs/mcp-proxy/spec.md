## ADDED Requirements

### Requirement: Proxy Client MCP servers
For each MCP server in `session/new` or `session/load`, the Adapter SHALL configure the Host Session with a stable Adapter-owned proxy endpoint and forward traffic to the server URL and headers (or stdio process) supplied by the current Client.

#### Scenario: Harmonic HTTP server
- **WHEN** the Client passes `{name: "harmonic", type: "http", url, headers}`
- **THEN** Claude in the Host Session can call that server's tools through the proxy

#### Scenario: Fresh credentials on Reattach
- **WHEN** a Client Reattaches with a new bearer token for the same server
- **THEN** subsequent MCP calls from the live Host Session use the new token without restarting it

### Requirement: Unavailable upstream
While no Client is attached, proxied MCP calls SHALL fail with a clear error rather than hang.

#### Scenario: Detached call
- **WHEN** Claude calls a proxied MCP tool while the session has no Owner
- **THEN** the call fails with an error stating the Client is disconnected
