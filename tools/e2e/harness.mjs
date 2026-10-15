/**
 * Probe plugin for `tools/verify-e2e.sh`.
 *
 * It boots inside a throwaway dsh profile, builds one source session holding a
 * finished turn, then invokes `revise-chan/plan` and `revise-chan/revise` through
 * the **real** Typert Gateway exactly as the Browser half does
 * (`{ args: { request } }`), forks the branch the way the Client asks for it
 * (`SessionStore.fork` at the prompt seq), and prints what the branch folds to.
 * The script greps this output.
 *
 * @module tools/e2e/harness
 */

/** Services this probe needs live before it can run. */
export const inject = ['sessions', 'typertGateway', 'sessionProjections']

/** Message ids and session ids used by the synthetic conversation. */
const MESSAGE_ID = 'msg-e2e'
const SOURCE_ID = 'session-e2e-source'
const CHILD_ID = 'session-e2e-child'
const QUESTION = 'probe question?'
const ANSWER = 'REVISED answer'

/**
 * @param ctx - booted profile context.
 */
export function apply(ctx) {
  void run(ctx)
}

/** @param ctx - booted profile context. */
async function run(ctx) {
  try {
    const source = ctx.sessions.create(SOURCE_ID, { meta: { cwd: process.cwd() } })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', {
      id: 'user-e2e', role: 'user', content: [{ type: 'text', text: QUESTION }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    source.append('step/start', { turn: 1, step: 1 })
    source.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: MESSAGE_ID,
        role: 'assistant',
        content: [
          { type: 'text', text: 'probe answer' },
          { type: 'reasoning', text: 'probe thinking' },
          { type: 'tool-call', callId: 'call-e2e', name: 'bash', args: '{}' },
        ],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [0], texts: ['probe answer'] }],
    }, { surfaceOp: 'append' })
    source.append('step/end', { turn: 1, step: 1 })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const planned = await ctx.typertGateway.invoke({
      namespace: 'revise-chan',
      method: 'plan',
      args: { request: { sessionId: SOURCE_ID, messageId: MESSAGE_ID } },
    })
    console.log('PROBE plan =>', JSON.stringify(planned))

    // The same fork the Client asks for: cut the log at the human prompt (seq 1).
    const child = ctx.sessions.fork(source, 1, CHILD_ID)
    console.log('PROBE child inherited =>', child.snapshotEvents().map(event => `${event.seq}:${event.type}`).join(' '))
    console.log('PROBE child before =>', JSON.stringify(child.deriveMessages().map(message => [message.role, message.content?.[0]?.text])))

    const revised = await ctx.typertGateway.invoke({
      namespace: 'revise-chan',
      method: 'revise',
      args: { request: { sourceSessionId: SOURCE_ID, childSessionId: CHILD_ID, messageId: MESSAGE_ID, text: ANSWER } },
    })
    console.log('PROBE revise =>', JSON.stringify(revised))
    console.log('PROBE child events =>', child.snapshotEvents().map(event => `${event.seq}:${event.type}`).join(' '))
    console.log('PROBE child after =>', JSON.stringify(child.deriveMessages().map(message => [message.role, message.content?.[0]?.text])))
    console.log('PROBE child turn boundary =>', JSON.stringify(ctx.sessionProjections.stateOf(child, 'turnBoundary')))

    const missing = await ctx.typertGateway.invoke({
      namespace: 'revise-chan',
      method: 'plan',
      args: { request: { sessionId: 'session-nope', messageId: MESSAGE_ID } },
    })
    console.log('PROBE missing session =>', JSON.stringify(missing))
  } catch (error) {
    console.log('PROBE FAILED =>', String(error === null || typeof error !== 'object' ? error : error.stack ?? error.message))
  } finally {
    process.exit(0)
  }
}
