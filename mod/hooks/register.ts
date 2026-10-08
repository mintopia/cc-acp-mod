import type { Register } from 'claude-code'

const PROTOCOL_VERSION = 1
const MOD_VERSION = '0.1.0'
const RETRY_MS = 1_000

type Event =
  | { type: 'turn_started'; turnId: string }
  | { type: 'chunk'; kind: 'text' | 'thinking'; text: string }
  | { type: 'tool_started'; toolUseId: string; tool: string; input: Record<string, unknown> }
  | { type: 'tool_finished'; toolUseId: string; isError: boolean }
  | { type: 'turn_completed'; reason: string }

let outbox: Event[] = []
let flushing = false
let connected = false
let socketPath: string | undefined
let started = false

function post($: any, path: string, body: unknown) {
  return $.http.fetch(`http://adapter${path}`, {
    method: 'POST',
    socketPath,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

async function flush($: any): Promise<void> {
  if (flushing || !connected) return
  flushing = true
  try {
    while (outbox.length > 0) {
      const batch = outbox
      outbox = []
      try {
        await post($, '/events', { events: batch })
      } catch {
        outbox = [...batch, ...outbox]
        $.clock.after(RETRY_MS, () => flush($))
        return
      }
    }
  } finally {
    flushing = false
  }
}

function emit($: any, event: Event) {
  outbox.push(event)
  void flush($)
}

function runCommand($: any, command: { type: string; text?: string }) {
  if (command.type === 'prompt' && command.text !== undefined) {
    void $.prompt.submit({ text: command.text }).catch(() => emit($, { type: 'turn_completed', reason: 'error' }))
  } else if (command.type === 'cancel') {
    void $.turn.abort().catch(() => {})
  }
}

async function pollOnce($: any): Promise<void> {
  try {
    const res = await $.http.fetch('http://adapter/poll', { socketPath })
    if (res.status === 200) runCommand($, JSON.parse(res.text))
    $.clock.after(0, () => pollOnce($))
  } catch {
    $.clock.after(RETRY_MS, () => pollOnce($))
  }
}

async function connect($: any): Promise<void> {
  try {
    const sessionId = await $.session.id()
    await post($, '/hello', { protocolVersion: PROTOCOL_VERSION, sessionId, modVersion: MOD_VERSION })
    connected = true
    void flush($)
    $.clock.after(0, () => pollOnce($))
  } catch {
    $.clock.after(RETRY_MS, () => connect($))
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    if (!started) {
      started = true
      const dir = (await $.process.run(['printenv', 'CC_ACP_SOCKET_DIR'])).stdout.trim()
      const sessionId = await $.session.id()
      socketPath = `${dir}/${sessionId}.sock`
      $.clock.after(0, () => connect($))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    emit($, { type: 'turn_started', turnId: e.turnId })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    for await (const chunk of next(e)) {
      if ((chunk.kind === 'text' || chunk.kind === 'thinking') && e.agentId === undefined) {
        emit($, { type: 'chunk', kind: chunk.kind, text: chunk.text })
      }
      yield chunk
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const { tool, tool_use_id: toolUseId, agentId: _agentId, ...input } = e as any
    emit($, { type: 'tool_started', toolUseId, tool, input })
    const ran = await next(e)
    emit($, { type: 'tool_finished', toolUseId, isError: ran.deny !== undefined || ran.isError === true })
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) emit($, { type: 'turn_completed', reason: e.reason })
    return next(e)
  })
}
