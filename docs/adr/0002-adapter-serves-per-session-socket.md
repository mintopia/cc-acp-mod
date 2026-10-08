# Host Sessions outlive the Adapter; the Adapter serves a per-session socket the Mod polls

Mods run sandboxed and cannot listen on a socket, and we want Host Sessions to survive the Adapter (and Client) going away so they can be Reattached. So each Host Session has a stable socket path keyed by its session id; whichever Adapter currently owns the session listens there, and the Mod long-polls it for commands and posts events to it, retrying and buffering the in-flight turn while no Adapter is present. Unattached Host Sessions are reaped after an idle timeout (default 1 hour, never while mid-turn or awaiting permission); a reaped session can still be Revived from its transcript by session id.

## Consequences

- An Adapter may Reattach to a Host Session running an older Mod. The Adapter and Mod exchange a protocol version on connect; on mismatch the Adapter waits for the Host Session to go idle and Revives it with the current Mod.
