# Content comes only from the Mod; tmux is used for keystrokes, never screen scraping

Where the mod API lacks a control action (e.g. switching permission mode, dismissing a dialog), the Adapter may fall back to `tmux send-keys`. It must never derive conversation content or state from `tmux capture-pane`: TUI rendering is unstable across releases and lossy, whereas mod hooks deliver structured events. A feature that can only be built by scraping the screen is dropped rather than built that way.
