import type { Register } from 'claude-code'

const PROTOCOL_VERSION = 1
const MOD_VERSION = '0.1.0'
const RETRY_MS = 1_000

type Event =
  | { type: 'turn_started'; turnId: string }
  | { type: 'chunk'; kind: 'text' | 'thinking'; text: string }
  | { type: 'tool_started'; toolUseId: string; tool: string; input: Record<string, unknown> }
  | { type: 'tool_finished'; toolUseId: string; isError: boolean; result?: unknown }
  | { type: 'turn_completed'; reason: string }
  | { type: 'model_changed'; id: string }
  | { type: 'config_changed'; option: 'effort' | 'fast'; value: string }
  | { type: 'ask_question'; requestId: string; questions: unknown[] }
  | { type: 'permission_request'; requestId: string; tool: string; input: Record<string, unknown>; toolUseId?: string; suggestions?: unknown[] }

let outbox: Event[] = []
let flushing = false
let connected = false
let socketPath: string | undefined
let started = false
let lastModel: string | undefined
let nextRequest = 0
const pendingQuestions = new Map<string, (answers: Record<string, string> | null) => void>()
let permissionSeq = 0

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

function runCommand(
  $: any,
  command: { type: string; text?: string; id?: string; value?: string; requestId?: string; answers?: Record<string, string> | null },
) {
  if (command.type === 'prompt' && command.text !== undefined) {
    void $.prompt.submit({ text: command.text }).catch(() => emit($, { type: 'turn_completed', reason: 'error' }))
  } else if (command.type === 'steer' && command.text !== undefined) {
    void $.prompt.steer({ text: command.text }).catch(() => {})
  } else if (command.type === 'question_answer' && command.requestId !== undefined) {
    pendingQuestions.get(command.requestId)?.(command.answers ?? null)
    pendingQuestions.delete(command.requestId)
  } else if (command.type === 'cancel') {
    void $.turn.abort().catch(() => {})
  } else if (command.type === 'set_model' && command.id !== undefined) {
    void $.command
      .run({ command: 'model', args: command.id })
      .then(() => reportModel($))
      .catch(() => reportModel($))
  } else if ((command.type === 'set_effort' || command.type === 'set_fast') && command.value !== undefined) {
    const option = command.type === 'set_effort' ? 'effort' : 'fast'
    const value = command.value
    void $.command
      .run({ command: option, args: value })
      .then(() => emit($, { type: 'config_changed', option, value }))
      .catch(() => {})
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
    await post($, '/hello', { protocolVersion: PROTOCOL_VERSION, sessionId, modVersion: MOD_VERSION,
      steering: typeof $.prompt?.steer === 'function',
    })
    connected = true
    void flush($)
    $.clock.after(0, () => pollOnce($))
  } catch {
    $.clock.after(RETRY_MS, () => connect($))
  }
}

async function awaitDecision($: any, requestId: string): Promise<string> {
  for (;;) {
    try {
      const res = await $.http.fetch(`http://adapter/permission?id=${encodeURIComponent(requestId)}`, { socketPath })
      if (res.status === 200) return JSON.parse(res.text).decision
    } catch {
      await new Promise<void>((resolve) => $.clock.after(RETRY_MS, resolve))
    }
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
    const isError = ran.deny !== undefined || ran.isError === true
    emit($, { type: 'tool_finished', toolUseId, isError, result: isError ? undefined : ran.result })
    return ran
  })

  on('classic.PermissionRequest', async ($: any, e: any, next: any) => {
    const input = e.tool_input
    if (e.tool_name === 'AskUserQuestion' && Array.isArray(input?.questions)) {
      const requestId = `q${++nextRequest}`
      const answered = new Promise<Record<string, string> | null>((resolve) => pendingQuestions.set(requestId, resolve))
      emit($, { type: 'ask_question', requestId, questions: input.questions })
      const answers = await answered
      if (answers === null) return { decision: { behavior: 'deny', message: 'The user declined to answer.' } }
      return { decision: { behavior: 'allow', updatedInput: { ...input, answers } } }
    }
    const requestId = `${Date.now()}-${++permissionSeq}`
    const suggestions = e.permission_suggestions
    emit($, {
      type: 'permission_request',
      requestId,
      tool: e.tool_name,
      input: input ?? {},
      toolUseId: e.tool_use_id,
      suggestions: Array.isArray(suggestions) ? suggestions : undefined,
    })
    const decision = await awaitDecision($, requestId)
    if (decision === 'allow_once') return { decision: { behavior: 'allow' } }
    if (decision === 'allow_with_updates') {
      return { decision: { behavior: 'allow', ...(Array.isArray(suggestions) ? { updatedPermissions: suggestions } : {}) } }
    }
    return { decision: { behavior: 'deny', message: 'Denied by the ACP client' } }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) emit($, { type: 'turn_completed', reason: e.reason })
    void reportModel($)
    return next(e)
  })
}
