export type ConnState = { socketPath: string; outbox: unknown[]; pending: unknown[] }

declare module 'claude-code' {
  interface PluginState {
    'cc-acp-mod': { conn: ConnState }
  }
}
