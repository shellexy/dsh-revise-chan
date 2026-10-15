/**
 * dsh-revise-chan — Host half.
 *
 * Provides the `revise-chan` Remote namespace with two direct endpoints:
 *
 * - `plan` — locate the surface-visible assistant message a revision targets and
 *   report the source `user/message` seq the branch may cut at.
 * - `revise` — append the revised turn to the already forked child session.
 *
 * A revision never rewrites an existing event. The child inherits the source log
 * through its original prompt, and the answer is then appended as a complete
 * turn (`turn/start`, `step/start`, `assistant/message`, `step/end`, `turn/end`)
 * carrying the edited text. The model-visible surface is the canonical fold over
 * those events, so the branch's history reads `…, prompt, edited answer`.
 *
 * `assistant/message` surface replacement is not used: an `assistant/message`
 * replacement must cite the node it shadows, and that event type forbids
 * `sourceEventSeqs`, so the operation is impossible on this format.
 *
 * The plugin is deliberately dependency-free: it imports nothing, and installs
 * the Remote method marker and the Typert binding the standard
 * `TypertRemoteService` would install, because a bundle linked into a profile
 * cannot resolve Harness package specifiers at import time.
 *
 * @module dsh-revise-chan
 */

/**
 * Prototype descriptor the standard `Remote` decorator installs. The Typert
 * Gateway's source-mode discovery reads it off the live service prototype.
 */
const REMOTE_METHODS_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Cordis service name, Typert namespace, and Remote endpoint prefix. */
const SERVICE_NAME = 'revise-chan'

/** Services this plugin reads. */
export const inject = ['sessions']

/** @param value - business result of one Remote call. */
function succeed(value) {
  return { ok: true, value }
}

/**
 * Build one business failure branch.
 * @param code - stable machine code the Browser half switches on.
 * @param message - operator-facing reason.
 */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Rebuild one assistant message's content around the edited reply: the first
 * text block becomes the edit, later text blocks are dropped with it, and
 * reasoning and image blocks survive unchanged.
 *
 * Tool-call blocks cannot survive: the tools that ran belong to the discarded
 * branch, so a rebuilt turn never claims their results.
 * @param original - the source message's content blocks.
 * @param text - the edited reply.
 * @returns the rebuilt content blocks.
 */
function revisedContent(original, text) {
  const content = []
  let replaced = false
  for (const block of original) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text') {
      if (!replaced) {
        content.push({ type: 'text', text })
        replaced = true
      }
      continue
    }
    if (block.type === 'reasoning' || block.type === 'image') content.push(block)
  }
  if (!replaced) content.unshift({ type: 'text', text })
  return content
}

/** The `revise-chan` Remote namespace: revision planning and the revised turn. */
class ReviseChanService {
  /**
   * @param ctx - owning Host context with the session store.
   */
  constructor(ctx) {
    this.ctx = ctx
    // Same binding `TypertRemoteService` publishes, built here so the plugin
    // needs no Harness import.
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: SERVICE_NAME,
      namespace: SERVICE_NAME,
    })
  }

  /**
   * Locate the surface-visible assistant message a revision targets, together
   * with the turn it closes.
   * @param request - `{ sessionId, messageId }` from the Browser half.
   * @returns the located facts, or one business failure.
   */
  locate(request) {
    const sessionId = request === null || typeof request !== 'object' ? undefined : request.sessionId
    const messageId = request === null || typeof request !== 'object' ? undefined : request.messageId
    if (typeof sessionId !== 'string' || typeof messageId !== 'string') {
      return { failure: fail('invalid-request', 'sessionId and messageId must be strings') }
    }
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) {
      return { failure: fail('session-not-found', `session ${sessionId} is not live in this process`) }
    }
    const events = session.snapshotEvents()
    const onSurface = new Set(session.surface.nodes)
    let event
    for (const candidate of events) {
      if (candidate.type !== 'assistant/message') continue
      if (candidate.data?.message?.id !== messageId) continue
      // Only the newest copy still standing on the surface is editable; an
      // older copy replaced by a later node is no longer what the reader sees.
      if (!onSurface.has(candidate.seq)) continue
      if (event === undefined || candidate.seq > event.seq) event = candidate
    }
    if (event === undefined) {
      return { failure: fail('message-not-found', `no surface-visible assistant message ${messageId} in ${sessionId}`) }
    }
    const turn = event.data.turn
    let turnStartSeq
    for (const candidate of events) {
      if (candidate.seq >= event.seq) break
      if (candidate.type === 'turn/start' && candidate.data?.turn === turn) turnStartSeq = candidate.seq
    }
    if (turnStartSeq === undefined) {
      return { failure: fail('turn-not-found', `turn ${turn} has no recorded start`) }
    }
    let promptSeq
    for (const candidate of events) {
      if (candidate.seq <= turnStartSeq || candidate.seq >= event.seq) continue
      if (candidate.type !== 'user/message') continue
      // Injected context and relayed material also arrive as `user/message`;
      // only a human prompt may stand in for the branch's question.
      if (candidate.data?.source?.kind !== 'user') continue
      promptSeq = candidate.seq
      break
    }
    if (promptSeq === undefined) {
      return { failure: fail('no-prompt', `turn ${turn} carries no human prompt to inherit`) }
    }
    return { failure: undefined, session, event, turn, turnStartSeq, promptSeq }
  }

  /**
   * Report where a revision of one answer must cut the source log, and the
   * facts the Browser half needs for naming.
   * @param request - `{ sessionId, messageId }`.
   * @returns `{ turn, forkSeq, messageTime }`, or one business failure.
   */
  async plan(request) {
    const located = this.locate(request)
    if (located.failure !== undefined) return located.failure
    return succeed({
      turn: located.turn,
      // The child inherits the prompt of the edited turn and nothing after it.
      forkSeq: located.promptSeq,
      messageTime: located.event.time,
    })
  }

  /**
   * Append the revised turn to an already forked child session.
   * @param request - `{ sourceSessionId, childSessionId, messageId, text }`.
   * @returns `{ turn, seq }` of the appended answer, or one business failure.
   */
  async revise(request) {
    const sourceSessionId = request === null || typeof request !== 'object' ? undefined : request.sourceSessionId
    const childSessionId = request === null || typeof request !== 'object' ? undefined : request.childSessionId
    const text = request === null || typeof request !== 'object' ? undefined : request.text
    const messageId = request === null || typeof request !== 'object' ? undefined : request.messageId
    if (typeof childSessionId !== 'string' || typeof text !== 'string') {
      return fail('invalid-request', 'childSessionId and text are required')
    }
    const located = this.locate({ sessionId: sourceSessionId, messageId })
    if (located.failure !== undefined) return located.failure
    const child = this.ctx.sessions.get(childSessionId)
    if (child === undefined) {
      return fail('session-not-found', `branch ${childSessionId} is not live in this process`)
    }
    if (child.id === located.session.id) {
      return fail('invalid-request', 'a revision needs a branch distinct from its source session')
    }
    const original = located.event.data.message
    // The answer reopens the turn its prompt already owns: the child inherited
    // that turn's `turn/start` and the fork closed it, so the branch's history
    // reads as one turn holding the original prompt and the edited answer. The
    // fork's own turn/end stays behind our later one, and the child Agent
    // already reserved turn N+1, so continuing the branch cannot collide with
    // this answer.
    const turn = located.turn
    const content = revisedContent(original.content, text)
    try {
      child.append('turn/start', { turn })
      child.append('step/start', { turn, step: 1 })
      child.append('assistant/message', {
        turn,
        step: 1,
        // Same identity, provider and model: the branch keeps the answer's slot,
        // and the text it carries is the reader's edit.
        message: { ...original, content },
        stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [0], texts: [text] }],
      }, { surfaceOp: 'append' })
      child.append('step/end', { turn, step: 1 })
      child.append('turn/end', { turn, reason: { kind: 'completed' } })
    } catch (error) {
      return fail('append-failed', `could not append the revised turn: ${String(error?.message ?? error)}`)
    }
    try {
      await this.ctx.sessions.flush(child)
    } catch (error) {
      // The browser reports the append as done either way: the session has
      // accepted the events, and the durability barrier belongs to the backend.
    }
    return succeed({ turn, seq: child.seq })
  }
}

// The Remote method markers the `@Remote('plan')` / `@Remote('revise')`
// decorators would install at class-definition time.
Object.defineProperty(ReviseChanService.prototype, REMOTE_METHODS_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze(['plan', 'revise'].map(method => Object.freeze({
      method,
      invocation: Object.freeze({ kind: 'direct' }),
    }))),
  }),
})

/**
 * Register the `revise-chan` service for this Host composition.
 * @param ctx - the plugin's Host context.
 */
export function apply(ctx) {
  ctx.provide(SERVICE_NAME, new ReviseChanService(ctx))
}
