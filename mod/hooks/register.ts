import type { Register } from 'claude-code'

const PROTOCOL_VERSION = 1
const MOD_VERSION = '0.1.0'
const RETRY_MS = 1_000
const MAX_RETRY_MS = 5_000
const MAX_BUFFERED = 5_000
const TITLE_MAX = 80
const DEFAULT_IDLE_MS = 3_600_000
const MAX_REAP_CHECK_MS = 60_000
const TMUX_SOCKET = 'cc-acp'
const COMMAND_TURN_WAIT_MS = 2_000
const PANEL_WAIT_MS = 3_000

type Event =
  | { type: 'turn_started'; turnId: string }
  | { type: 'chunk'; kind: 'text' | 'thinking'; text: string }
  | { type: 'tool_started'; toolUseId: string; tool: string; input: Record<string, unknown> }
  | { type: 'tool_finished'; toolUseId: string; isError: boolean; result?: unknown }
  | { type: 'turn_completed'; reason: string }
  | { type: 'model_changed'; id: string }
  | { type: 'config_changed'; option: 'effort' | 'fast'; value: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedReadTokens?: number; cachedWriteTokens?: number; contextUsed: number; contextSize: number }
  | { type: 'title'; title: string }
  | { type: 'commands'; commands: { name: string; description?: string; argumentHint?: string; terminalOnly?: boolean }[] }
  | { type: 'ask_question'; requestId: string; questions: unknown[] }
  | { type: 'permission_request'; requestId: string; tool: string; input: Record<string, unknown>; toolUseId?: string; suggestions?: unknown[] }
  | { type: 'mode'; mode: string }

const conn = { plugin: 'cc-acp-mod', key: 'conn' } as const

let outbox: Event[] = []
let flushing = false
let connected = false
let socketPath: string | undefined
let started = false
let retryMs = RETRY_MS
let reconnectScheduled = false
let pollEpoch = 0
let persistQueued = false
type PermissionRequest = Extract<Event, { type: 'permission_request' }>
const pending = new Map<string, PermissionRequest>()
let lastModel: string | undefined
let lastTitle: string | undefined
let lastCommands: string | undefined
let nextRequest = 0
const pendingQuestions = new Map<string, (answers: Record<string, string> | null) => void>()
let permissionSeq = 0
let lastMode: string | undefined
let probing = false
let probeCount = 0
let probeCommand: string | undefined
let turnsStarted = 0
let compactions = 0
let pendingCommand: ((reply: string | undefined, reason?: string) => void) | undefined
let probeFile: string | undefined
let idleMs = DEFAULT_IDLE_MS
let unownedSince: number | undefined
let turnActive = false
let hitMaxTokens = false

async function post($: any, path: string, body: unknown) {
  const res = await $.http.fetch(`http://adapter${path}`, {
    method: 'POST',
    socketPath,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
  if (res.status >= 300) throw new Error(`${path} -> ${res.status}`)
  return res
}

function persist($: any) {
  if (persistQueued) return
  persistQueued = true
  $.clock.after(0, async () => {
    persistQueued = false
    try {
      await $.state.set(conn, { socketPath: socketPath ?? '', outbox, pending: [...pending.values()] })
    } catch {}
  })
}

async function restore($: any): Promise<void> {
  try {
    const { value } = await $.state.get(conn)
    if (!value) return
    socketPath = socketPath ?? (value.socketPath || undefined)
    outbox = [...(value.outbox as Event[]), ...outbox]
    for (const p of value.pending as PermissionRequest[]) pending.set(p.requestId, p)
  } catch {}
}

function scheduleReconnect($: any) {
  if (reconnectScheduled) return
  reconnectScheduled = true
  const delay = retryMs
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
  $.clock.after(delay, () => connect($))
}

function markDisconnected($: any) {
  if (!connected) return
  connected = false
  unownedSince = Date.now()
  pollEpoch++
  scheduleReconnect($)
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
        persist($)
        markDisconnected($)
        return
      }
    }
    persist($)
  } finally {
    flushing = false
  }
}

function reportMode($: any, e: any) {
  const mode = e.permission_mode
  if (typeof mode === 'string' && e.agent_id === undefined && (mode !== lastMode || probing)) {
    lastMode = mode
    probing = false
    emit($, { type: 'mode', mode })
  }
}

function emit($: any, event: Event) {
  outbox.push(event)
  if (outbox.length > MAX_BUFFERED) outbox.splice(0, outbox.length - MAX_BUFFERED)
  persist($)
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

async function reportUsage($: any, e: any): Promise<void> {
  const u = e.usage
  if (!u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return
  const cacheRead = u.cache_read_input_tokens
  const cacheWrite = u.cache_creation_input_tokens
  let contextSize = 200_000
  let contextUsed = u.input_tokens + (cacheRead ?? 0) + (cacheWrite ?? 0) + u.output_tokens
  try {
    const { context } = await $.session.usage()
    if (typeof context.window === 'number') contextSize = context.window
    if (typeof context.tokens === 'number') contextUsed = context.tokens
  } catch {}
  emit($, {
    type: 'usage',
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    ...(typeof cacheRead === 'number' ? { cachedReadTokens: cacheRead } : {}),
    ...(typeof cacheWrite === 'number' ? { cachedWriteTokens: cacheWrite } : {}),
    contextUsed,
    contextSize,
  })
}

async function reportTitle($: any): Promise<void> {
  if (lastTitle !== undefined) return
  try {
    const first = (await $.session.messages()).find((m: any) => m.role === 'user' && typeof m.text === 'string' && m.text.trim() !== '')
    if (!first) return
    const line = (first.text.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ')
    const title = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
    lastTitle = title
    emit($, { type: 'title', title })
  } catch {}
}

async function reportCommands($: any): Promise<void> {
  try {
    const list = await $.command.list()
    if (!Array.isArray(list)) return
    const commands = list
      .filter((c: any) => typeof c?.name === 'string')
      .map((c: any) => ({
        name: c.name,
        ...(typeof c.description === 'string' ? { description: c.description } : {}),
        ...(typeof c.argumentHint === 'string' ? { argumentHint: c.argumentHint } : {}),
        ...(c.terminalOnly === true || c.interactive === true || c.type === 'local-jsx' ? { terminalOnly: true } : {}),
      }))
    const key = JSON.stringify(commands)
    if (key === lastCommands) return
    lastCommands = key
    emit($, { type: 'commands', commands })
  } catch {}
}

function submitPrompt($: any, text: string) {
  const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!slash) {
    void $.prompt.submit({ text, asUser: true }).catch(() => emit($, { type: 'turn_completed', reason: 'error' }))
    return
  }
  const before = turnsStarted
  const compactionsBefore = compactions
  let settled = false
  const finish = (reply: string | undefined, reason = 'answer') => {
    if (settled) return
    settled = true
    if (pendingCommand === finish) pendingCommand = undefined
    if (turnsStarted !== before) return
    if (reply) emit($, { type: 'chunk', kind: 'text', text: reply })
    emit($, { type: 'turn_completed', reason })
  }
  pendingCommand = finish
  $.clock.after(PANEL_WAIT_MS, async () => {
    if (settled || turnsStarted !== before || compactions !== compactionsBefore) return
    try {
      const sessionId = await $.session.id()
      await $.process.run(['tmux', '-L', TMUX_SOCKET, 'send-keys', '-t', `cc-acp-${sessionId}`, 'Escape'])
    } catch {}
    finish(`/${slash[1]} opens an interactive panel, which this Client can't show.`)
  })
  void $.command.run({ command: slash[1], args: slash[2] ?? '' }).then(
    (result: { text?: string } | undefined) => {
      if (result?.text !== undefined) finish(result.text)
      else $.clock.after(COMMAND_TURN_WAIT_MS, () => finish(undefined))
    },
    (error: unknown) => finish(error instanceof Error ? error.message : String(error)),
  )
}

function runCommand(
  $: any,
  command: { type: string; text?: string; id?: string; value?: string; requestId?: string; answers?: Record<string, string> | null },
) {
  if (command.type === 'prompt' && command.text !== undefined) {
    submitPrompt($, command.text)
  } else if (command.type === 'steer' && command.text !== undefined) {
    void $.prompt.steer({ text: command.text }).catch(() => {})
  } else if (command.type === 'question_answer' && command.requestId !== undefined) {
    pendingQuestions.get(command.requestId)?.(command.answers ?? null)
    pendingQuestions.delete(command.requestId)
  } else if (command.type === 'cancel') {
    pendingCommand?.(undefined, 'aborted')
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

async function pollOnce($: any, epoch: number): Promise<void> {
  if (epoch !== pollEpoch) return
  try {
    const res = await $.http.fetch('http://adapter/poll', { socketPath })
    if (res.status === 409) throw new Error('Adapter has not seen hello')
    if (res.status === 200) runCommand($, JSON.parse(res.text))
    if (epoch === pollEpoch) $.clock.after(0, () => pollOnce($, epoch))
  } catch {
    if (epoch === pollEpoch) markDisconnected($)
  }
}

async function steeringSupported($: any): Promise<boolean> {
  try {
    await $.prompt.steer({ text: '' })
  } catch (err) {
    return !/not a function|undefined/i.test(String(err))
  }
  return true
}

async function connect($: any): Promise<void> {
  reconnectScheduled = false
  try {
    const sessionId = await $.session.id()
    const steering = await steeringSupported($)
    for (const request of pending.values()) {
      if (!outbox.some((e) => e.type === 'permission_request' && e.requestId === request.requestId)) outbox.push(request)
    }
    await post($, '/hello', { protocolVersion: PROTOCOL_VERSION, sessionId, modVersion: MOD_VERSION, steering, buffered: outbox.length, busy: isBusy() })
    connected = true
    unownedSince = undefined
    retryMs = RETRY_MS
    void flush($)
    const epoch = ++pollEpoch
    $.clock.after(0, () => pollOnce($, epoch))
  } catch {
    scheduleReconnect($)
  }
}

async function awaitDecision($: any, requestId: string): Promise<string> {
  for (;;) {
    try {
      const res = await $.http.fetch(`http://adapter/permission?id=${encodeURIComponent(requestId)}`, { socketPath })
      if (res.status === 200) return JSON.parse(res.text).decision
      if (res.status === 409) await new Promise<void>((resolve) => $.clock.after(RETRY_MS, resolve))
    } catch {
      await new Promise<void>((resolve) => $.clock.after(RETRY_MS, resolve))
    }
  }
}

function parseIdleMs(raw: string): number {
  const n = Number(raw)
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_MS
}

function isBusy(): boolean {
  return turnActive || pending.size > 0 || pendingQuestions.size > 0
}

function scheduleReapCheck($: any) {
  $.clock.after(Math.min(MAX_REAP_CHECK_MS, idleMs), () => reapCheck($))
}

async function reapCheck($: any): Promise<void> {
  if (connected || isBusy()) unownedSince = connected ? undefined : Date.now()
  if (!connected && unownedSince !== undefined && Date.now() - unownedSince >= idleMs) {
    try {
      const sessionId = await $.session.id()
      if (socketPath) await $.process.run(['rm', '-f', socketPath])
      await $.process.run(['tmux', '-L', TMUX_SOCKET, 'kill-session', '-t', `cc-acp-${sessionId}`])
    } catch {}
    return
  }
  scheduleReapCheck($)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    if (!started) {
      started = true
      await restore($)
      const dir = (await $.process.run(['printenv', 'CC_ACP_SOCKET_DIR'])).stdout.trim()
      probeFile = (await $.process.run(['printenv', 'CC_ACP_PROBE_FILE'])).stdout.trim()
      probeCommand = (await $.process.run(['printenv', 'CC_ACP_PROBE_COMMAND'])).stdout.trim()
      idleMs = parseIdleMs((await $.process.run(['printenv', 'CC_ACP_IDLE_TIMEOUT_MS'])).stdout.trim())
      unownedSince = Date.now()
      if (idleMs > 0) scheduleReapCheck($)
      if (probeCommand) await $.command.register({ name: probeCommand, description: 'Report the permission mode to the cc-acp Adapter' })
      const sessionId = await $.session.id()
      socketPath = `${dir}/${sessionId}.sock`
      $.clock.after(0, () => connect($))
      $.clock.after(0, () => reportModel($))
      $.clock.after(0, () => reportCommands($))
    }
    return next(e)
  })

  on('tool.check', { tool: 'Read' }, async ($, e, next) => {
    if (probing && (e.input as { file_path?: string }).file_path === probeFile) return { decision: 'allow' }
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (probeCommand === undefined || probeFile === undefined || e.command !== probeCommand) return next(e)
    probing = true
    try {
      probeCount += 1
      await $.tool.call({ tool: 'Read', file_path: probeFile, limit: probeCount })
    } finally {
      probing = false
    }
    return { text: '' }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    reportMode($, e)
    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    reportMode($, e)
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    reportMode($, e)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    reportMode($, e)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    compactions++
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) {
      turnActive = true
      turnsStarted++
      hitMaxTokens = false
    }
    void reportModel($)
    emit($, { type: 'turn_started', turnId: e.turnId })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    for await (const chunk of next(e)) {
      if (chunk.kind === 'stop' && e.agentId === undefined) hitMaxTokens = chunk.stopReason === 'max_tokens'
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
    reportMode($, e)
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
    const request = {
      type: 'permission_request' as const,
      requestId,
      tool: e.tool_name,
      input: input ?? {},
      ...(Array.isArray(suggestions) ? { suggestions } : {}),
    }
    pending.set(requestId, request)
    emit($, request)
    const decision = await awaitDecision($, requestId)
    pending.delete(requestId)
    persist($)
    if (decision === 'allow_once') return { decision: { behavior: 'allow' } }
    if (decision === 'allow_with_updates') {
      return { decision: { behavior: 'allow', ...(Array.isArray(suggestions) ? { updatedPermissions: suggestions } : {}) } }
    }
    return { decision: { behavior: 'deny', message: 'Denied by the ACP client' } }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnActive = false
      await reportUsage($, e)
      await reportTitle($)
      emit($, { type: 'turn_completed', reason: e.reason === 'answer' && hitMaxTokens ? 'max_tokens' : e.reason })
    }
    void reportModel($)
    void reportCommands($)
    return next(e)
  })
}
