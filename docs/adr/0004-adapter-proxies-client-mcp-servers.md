# The Adapter proxies the Client's MCP servers rather than passing them to the Host Session

Clients such as Harmonic mint fresh MCP credentials on every `session/load`, but a Reattached Host Session keeps the MCP configuration it was launched with. So the Host Session is always configured with a stable, Adapter-owned proxy endpoint per Client MCP server, and the proxy forwards to whatever URL and headers (or stdio process) the currently attached Client supplied. Passing the servers straight through would be simpler but breaks MCP after any Reattach.
