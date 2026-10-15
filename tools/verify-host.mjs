#!/usr/bin/env node
/**
 * Verify the Host half: the Typert Gateway's source-mode discovery rule must
 * claim `revise-chan/plan` and `revise-chan/revise` off the live service, and the
 * two operations must behave on a session whose events are shaped like a real
 * log (including an injected-context `user/message` the prompt filter must skip).
 *
 * The discovery rule is reproduced here exactly as the gateway implements it
 * (binding shape + Remote method descriptor + reflected parameter names); the
 * end-to-end proof through the real gateway is `tools/verify-e2e.sh`.
 *
 * Usage: `node tools/verify-host.mjs`
 * @module tools/verify-host
 */

import { importDsh, importPluginHost } from './lib/dsh-modules.mjs'

const checks = []
/**
 * Record one check.
 * @param name - what is being checked.
 * @param run - predicate; throwing fails the check.
 */
function check(name, run) {
  try {
    run()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error: String(error === null || typeof error !== 'object' ? error : error.message) })
  }
}

/**
 * Assert one condition.
 * @param condition - value that must be truthy.
 * @param message - failure description.
 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Assert one deep equality.
 * @param actual - observed value.
 * @param expected - expected value.
 * @param message - failure description.
 */
function assertEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
}

/** Let the Cordis fiber tree settle one turn of the event loop. */
const tick = () => new Promise(resolve => setTimeout(resolve, 20))

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const MESSAGE_ID = 'msg-1'

/** One text block. @param text - prose. */
const text = value => ({ type: 'text', text: value })

/** A user-role message event payload. @param id - message id. @param kind - source kind. */
const userMessage = (id, kind) => ({
  id, role: 'user', content: [text(kind === 'user' ? 'the question' : 'injected context')], source: { kind },
})

/** The assistant answer the revision targets. @param seq - log position. */
const assistantEvent = seq => ({
  type: 'assistant/message',
  seq,
  time: 1_700_000_000_000,
  surfaceOp: 'append',
  data: {
    turn: 1,
    step: 1,
    message: {
      id: MESSAGE_ID,
      role: 'assistant',
      content: [text('original answer'), { type: 'reasoning', text: 'why' }, { type: 'tool-call', callId: 'call-1', name: 'bash', args: '{}' }],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    },
    stream: [],
  },
})

/**
 * Build one fake source session.
 * @param options - `id` names the session, `promptKind` selects a human prompt
 *   or injected context only, `answerOffSurface` hides the answer from the fold.
 */
function sourceSession(options = {}) {
  const promptKind = options.promptKind ?? 'user'
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: userMessage('ctx-1', 'skill') },
    { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append', data: userMessage('u-1', promptKind) },
    { type: 'step/start', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    assistantEvent(4),
    { type: 'step/end', seq: 5, time: 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return {
    id: options.id ?? 'session-source',
    events,
    snapshotEvents: () => events,
    // The answer is off-surface when the test asks for that.
    surface: { nodes: options.answerOffSurface === true ? [1, 2] : [1, 2, 4] },
  }
}

/** One fake forked child that records what the Host half appends. */
function childSession() {
  const appended = []
  const child = {
    id: 'session-child',
    seq: 9,
    appended,
    flushCount: 0,
    /** @param type - event type. @param data - payload. @param opts - surface intent. */
    append(type, data, opts) {
      appended.push({ type, data, opts })
      return { seq: appended.length }
    },
  }
  return child
}

const [{ Context }, plugin] = await Promise.all([importDsh('@deepseek-ai/cordis'), importPluginHost()])

const store = { sessions: new Map(), flushes: 0 }
store.get = id => store.sessions.get(id)
store.flush = async () => { store.flushes += 1; return true }

const root = new Context()
root.plugin({ name: 'verify-host-stub-sessions', apply(ctx) { ctx.provide('sessions', store) } })
await tick()
root.plugin({ name: 'dsh-revise-chan-host', inject: plugin.inject, apply: plugin.apply })
await tick()

// ── The gateway's source-mode discovery rule, reproduced ────────────────────
/**
 * Read the Remote method markers off a live service.
 * @param service - live service instance.
 * @returns stored method markers.
 */
function remoteMethods(service) {
  const prototype = Object.getPrototypeOf(service)
  if (prototype === null) return []
  const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHODS)?.value
  return descriptor === undefined ? [] : descriptor.methods
}

/**
 * Reflect one method's parameter names the way the gateway does.
 * @param service - live service instance.
 * @param method - method name.
 * @returns parameter names in signature order.
 */
function parameterNames(service, method) {
  let prototype = Object.getPrototypeOf(service)
  let implementation
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
    if (descriptor !== undefined) { implementation = descriptor.value; break }
    prototype = Object.getPrototypeOf(prototype)
  }
  const source = Function.prototype.toString.call(implementation)
  const body = source.slice(source.indexOf('(') + 1, source.indexOf(')')).trim()
  return body === '' ? [] : body.split(',').map(part => part.trim())
}

const service = root.get('revise-chan')
check('revise-chan service is provided', () => assert(service !== undefined, 'ctx.get("revise-chan") is undefined'))
check('typertRemote binding matches the service key and namespace', () => {
  const binding = service.typertRemote
  assert(binding.service === service, 'binding.service is not the service instance')
  assert(binding.serviceKey === 'revise-chan', `binding.serviceKey is ${String(binding.serviceKey)}`)
  assert(binding.namespace === 'revise-chan', `binding.namespace is ${String(binding.namespace)}`)
})
check('discovery claims plan/revise as direct endpoints with a request wire field', () => {
  const claims = remoteMethods(service).map(marker => ({
    endpoint: `${service.typertRemote.namespace}/${marker.exportName ?? marker.method}`,
    invocation: marker.invocation.kind,
    wire: parameterNames(service, marker.method),
  }))
  assertEqual(claims, [
    { endpoint: 'revise-chan/plan', invocation: 'direct', wire: ['request'] },
    { endpoint: 'revise-chan/revise', invocation: 'direct', wire: ['request'] },
  ], 'claimed endpoints differ')
})

// ── plan ────────────────────────────────────────────────────────────────────
const source = sourceSession({ id: 'session-source' })
const noPromptSource = sourceSession({ id: 'session-no-prompt', promptKind: 'skill' })
const offSurfaceSource = sourceSession({ id: 'session-off-surface', answerOffSurface: true })
const child = childSession()
store.sessions.set(source.id, source)
store.sessions.set(noPromptSource.id, noPromptSource)
store.sessions.set(offSurfaceSource.id, offSurfaceSource)
store.sessions.set(child.id, child)

const planned = await service.plan({ sessionId: source.id, messageId: MESSAGE_ID })
check('plan cuts at the human prompt, not at injected context', () => {
  assertEqual(planned, { ok: true, value: { turn: 1, forkSeq: 2, messageTime: 1_700_000_000_000 } }, 'plan result differs')
})
const missingSession = await service.plan({ sessionId: 'session-nope', messageId: MESSAGE_ID })
const missingMessage = await service.plan({ sessionId: source.id, messageId: 'msg-nope' })
const noPrompt = await service.plan({ sessionId: noPromptSource.id, messageId: MESSAGE_ID })
check('plan reports a missing session', () => assertEqual(missingSession.error.code, 'session-not-found', 'wrong code'))
check('plan reports a missing message', () => assertEqual(missingMessage.error.code, 'message-not-found', 'wrong code'))
check('plan rejects a turn with no human prompt', () => {
  assert(noPrompt.ok === false, 'expected a business failure')
  assert(noPrompt.error.message.includes('no human prompt'), `unexpected message: ${noPrompt.error.message}`)
})
const offSurfaceResult = await service.plan({ sessionId: offSurfaceSource.id, messageId: MESSAGE_ID })
check('plan ignores an answer that left the surface', () => assertEqual(offSurfaceResult.error.code, 'message-not-found', 'wrong code'))
const malformed = await service.plan({ sessionId: 1, messageId: null })
check('plan rejects a malformed request', () => assertEqual(malformed.error.code, 'invalid-request', 'wrong code'))

// ── revise ──────────────────────────────────────────────────────────────────
const revised = await service.revise({
  sourceSessionId: source.id,
  childSessionId: child.id,
  messageId: MESSAGE_ID,
  text: 'REVISED answer',
})
check('revise appends one complete turn and reports it', () => {
  assertEqual(revised.ok, true, 'revise failed')
  assertEqual(child.appended.map(entry => entry.type), ['turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end'], 'appended types differ')
  assertEqual(store.flushes, 1, 'flush was not awaited once')
})
check('revise keeps the original turn number', () => {
  for (const entry of child.appended) assertEqual(entry.data.turn, 1, 'turn number changed')
})
check('revise appends the answer with the append surface op', () => {
  const answer = child.appended[2]
  assertEqual(answer.opts, { surfaceOp: 'append' }, 'surface intent differs')
  assertEqual(answer.data.step, 1, 'step differs')
})
check('revise rewrites the text, keeps reasoning and images, drops tool calls', () => {
  const content = child.appended[2].data.message.content
  assertEqual(content.map(block => block.type), ['text', 'reasoning'], 'content blocks differ')
  assertEqual(content[0].text, 'REVISED answer', 'text was not replaced')
})
check('revise keeps the message identity, provider and model', () => {
  const message = child.appended[2].data.message
  assertEqual([message.id, message.source.provider, message.source.model], [MESSAGE_ID, 'deepseek', 'deepseek-chat'], 'identity or route changed')
})
check('revise writes a stream consistent with the edited text', () => {
  const stream = child.appended[2].data.stream
  assertEqual(stream, [{ type: 'text-chunks', time0: stream[0].time0, index: 0, dt: [0], texts: ['REVISED answer'] }], 'stream differs')
  assert(Number.isSafeInteger(stream[0].time0) && stream[0].time0 > 0, 'stream lost its timestamp')
})

const selfChild = childSession()
store.sessions.set(selfChild.id, selfChild)
const sameSession = await service.revise({ sourceSessionId: source.id, childSessionId: source.id, messageId: MESSAGE_ID, text: 'x' })
const unknownChild = await service.revise({ sourceSessionId: source.id, childSessionId: 'session-nope', messageId: MESSAGE_ID, text: 'x' })
const badText = await service.revise({ sourceSessionId: source.id, childSessionId: child.id, messageId: MESSAGE_ID, text: 7 })
check('revise refuses the source session as its own branch', () => assertEqual(sameSession.error.code, 'invalid-request', 'wrong code'))
check('revise reports a missing branch', () => assertEqual(unknownChild.error.code, 'session-not-found', 'wrong code'))
check('revise rejects non-string text', () => assertEqual(badText.error.code, 'invalid-request', 'wrong code'))

for (const row of checks) console.log(`${row.ok ? '✔' : '✘'} ${row.name}${row.ok ? '' : ` — ${row.error}`}`)
const failed = checks.filter(row => !row.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
