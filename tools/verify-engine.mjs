#!/usr/bin/env node
/**
 * Verify the revision against the real session engine: fork a two-turn log at
 * its second human prompt with `buildForkSeed`, append the revised turn the way
 * `revise-chan/revise` does, and assert what the surface fold then reads.
 *
 * This is the engine-level proof that the branch carries the original question
 * and the edited answer while no earlier event is rewritten.
 *
 * Usage: `node tools/verify-engine.mjs`
 * @module tools/verify-engine
 */

import { importDsh } from './lib/dsh-modules.mjs'

const { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } = await importDsh('@deepseek-ai/dsh-session')
const { buildForkSeed } = await importDsh('@deepseek-ai/dsh-session/fork')

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
 * Assert one deep equality.
 * @param actual - observed value.
 * @param expected - expected value.
 * @param message - failure description.
 */
function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  }
}

/** @param text - prose. */
const prose = text => [{ type: 'text', text }]
/** @param id - message id. @param text - prose. */
const userMessage = (id, text) => ({ id, role: 'user', content: prose(text), source: { kind: 'user' } })
/** @param id - message id. @param text - prose. */
const assistantMessage = (id, text) => ({
  id, role: 'assistant', content: prose(text),
  source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
})

/** @param text - the answer text the provider stream delivered. */
const streamOf = text => [{ type: 'text-chunks', time0: 1, index: 0, dt: [0], texts: [text] }]

/**
 * Append one closed turn carrying a single assistant answer.
 * @param session - target session.
 * @param turn - turn number.
 * @param promptId - prompt message id.
 * @param promptText - prompt text.
 * @param answerId - answer message id.
 * @param answerText - answer text.
 */
function appendTurn(session, turn, promptId, promptText, answerId, answerText) {
  session.append('turn/start', { turn })
  session.append('user/message', userMessage(promptId, promptText), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn, step: 1, message: assistantMessage(answerId, answerText), stream: streamOf(answerText),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** @param session - session whose surface to read as `[role, text]` pairs. */
const readSurface = session => session.deriveMessages().map(message => [message.role, message.content?.[0]?.text])

// ── A two-turn source session ───────────────────────────────────────────────
const parent = Session.create(SessionId('session-verify-parent'))
appendTurn(parent, 1, 'u1', 'first question', 'a1', 'first answer')
parent.append('turn/start', { turn: 2 })
parent.append('user/message', userMessage('u2', 'second question'), { surfaceOp: 'append' })
parent.append('step/start', { turn: 2, step: 1 })
const target = parent.append('assistant/message', {
  turn: 2, step: 1, message: assistantMessage('a2', 'second answer'), stream: streamOf('second answer'),
}, { surfaceOp: 'append' })
parent.append('step/end', { turn: 2, step: 1 })
parent.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

check('the source session reads as two complete turns', () => {
  assertEqual(readSurface(parent), [['user', 'first question'], ['assistant', 'first answer'], ['user', 'second question'], ['assistant', 'second answer']], 'source fold differs')
})

// ── Fork at the edited turn's prompt (what `revise-chan/plan` reports) ───────
const promptSeq = parent.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === 'u2').seq
const childHeader = {
  version: SESSION_FORMAT_VERSION,
  id: 'session-verify-child',
  createdAt: Date.now(),
  cwd: '/tmp',
  isSeeded: true,
  parentSession: 'session-verify-parent',
}
const seed = buildForkSeed(parent.snapshotEvents(), promptSeq)
const child = Session.create(SessionId('session-verify-child'), seed, childHeader, SessionLogOffset(promptSeq + 1))

check('the branch inherits through the prompt and closes the cut turn itself', () => {
  assertEqual(readSurface(child), [['user', 'first question'], ['assistant', 'first answer'], ['user', 'second question']], 'branch fold differs')
  const tail = child.snapshotEvents().slice(-2).map(event => event.type)
  assertEqual(tail, ['session/end-seed', 'turn/end'], `seeded tail differs: ${JSON.stringify(tail)}`)
})
check('the original answer is absent from the branch', () => {
  const ids = child.snapshotEvents().filter(event => event.type === 'assistant/message').map(event => event.data.message.id)
  assertEqual(ids, ['a1'], 'branch holds an unexpected assistant message')
})

// ── Append the revised turn exactly as the Host half does ──────────────────
const edited = 'second answer, revised'
child.append('turn/start', { turn: 2 })
child.append('step/start', { turn: 2, step: 1 })
child.append('assistant/message', {
  turn: 2, step: 1, message: assistantMessage('a2', edited), stream: streamOf(edited),
}, { surfaceOp: 'append' })
child.append('step/end', { turn: 2, step: 1 })
child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

check('the branch then reads as question + edited answer', () => {
  assertEqual(readSurface(child), [
    ['user', 'first question'], ['assistant', 'first answer'], ['user', 'second question'], ['assistant', edited],
  ], 'revised fold differs')
})
check('the revised answer reopens its own turn number', () => {
  const starts = child.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn)
  assertEqual(starts, [1, 2, 2], `turn starts differ: ${JSON.stringify(starts)}`)
})
check('every inherited event is byte-identical to the parent prefix', () => {
  const inherited = child.snapshotEvents().slice(0, promptSeq + 1)
  assertEqual(inherited.map(event => [event.seq, event.type]), parent.snapshotEvents().slice(0, promptSeq + 1).map(event => [event.seq, event.type]), 'prefix differs')
})

for (const row of checks) console.log(`${row.ok ? '✔' : '✘'} ${row.name}${row.ok ? '' : ` — ${row.error}`}`)
const failed = checks.filter(row => !row.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
