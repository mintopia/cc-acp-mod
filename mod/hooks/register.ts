import type { Register } from 'claude-code'

const PROTOCOL_VERSION = 1
const MOD_VERSION = '0.1.0'
const RETRY_MS = 1_000

type Event =
  | { type: 'turn_started'; turnId: string }
  | { type: 'chunk'; kind: 'text'; text: string }
  | { type: 'turn_completed'; reason: string }
  | { type: 'model_changed'; id: string }

let outbox: Event[] = []
let flushing = false
let connected = false
let socketPath: string | undefined
let started = false
let lastModel: string | undefined

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

async function reportModel($: any): Promise<void> {
  try {
    const id = await $.session.model()
    if (typeof id === 'string' && id !== lastModel) {
      lastModel = id
      emit($, { type: 'model_changed', id })
    }
  } catch {}
}

function runCommand($: any, command: { type: string; text?: string; id?: string }) {
  if (command.type === 'prompt' && command.text !== undefined) {
    void $.prompt.submit({ text: command.text }).catch(() => emit($, { type: 'turn_completed', reason: 'error' }))
  } else if (command.type === 'cancel') {
    void $.turn.abort().catch(() => {})
  } else if (command.type === 'set_model' && command.id !== undefined) {
    void $.command
      .run({ command: 'model', args: command.id })
      .then(() => reportModel($))
      .catch(() => reportModel($))
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
      $.clock.after(0, () => reportModel($))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    void reportModel($)
    emit($, { type: 'turn_started', turnId: e.turnId })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    for await (const chunk of next(e)) {
      if (chunk.kind === 'text' && e.agentId === undefined) {
        emit($, { type: 'chunk', kind: 'text', text: chunk.text })
      }
      yield chunk
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) emit($, { type: 'turn_completed', reason: e.reason })
    void reportModel($)
    return next(e)
  })
}
