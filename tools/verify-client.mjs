#!/usr/bin/env node
/**
 * Verify the Browser half without a browser.
 *
 * A miniature React runtime (tools/lib/mini-react.mjs) renders the registered
 * components with realistic slot props, so the checks cover the behaviour behind
 * their hooks too: the byline text, the pencil's hand-off, the editor draft, and
 * the floating outline opening, listing turns, highlighting the active one,
 * jumping to a row, closing, and withdrawing when the Conversation unmounts.
 *
 * `saveRevision` runs against stub session services, asserting the RPC payloads,
 * the fork boundary, the new title rule and the archive/open order.
 *
 * Usage: `node tools/verify-client.mjs`
 * @module tools/verify-client
 */

import { importPluginClient } from './lib/dsh-modules.mjs'
import { createMiniReact } from './lib/mini-react.mjs'

const checks = []
const pending = []
/**
 * Record one check. An async predicate is awaited before the report prints.
 * @param name - what is being checked.
 * @param run - predicate; throwing (or rejecting) fails the check.
 */
function check(name, run) {
  let result
  try {
    result = run()
  } catch (error) {
    checks.push({ name, ok: false, error: String(error === null || typeof error !== 'object' ? error : error.message) })
    return
  }
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    pending.push(result.then(
      () => { checks.push({ name, ok: true }) },
      error => { checks.push({ name, ok: false, error: String(error === null || typeof error !== 'object' ? error : error.message) }) },
    ))
  } else {
    checks.push({ name, ok: true })
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

/** @param condition - value that must be truthy. @param message - failure description. */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// ── The DOM the components read: the Conversation scrollport and its rows ────
const scrolled = []
/**
 * One fake turn row.
 * @param turn - the turn number the row stands for.
 */
const rowFor = turn => ({
  getAttribute: () => String(turn),
  getBoundingClientRect: () => ({ top: 120, height: 40 }),
  scrollIntoView: options => scrolled.push([turn, options.block]),
})
const scrollport = {
  getBoundingClientRect: () => ({ top: 96, right: 900, height: 600, width: 800 }),
  querySelector: selector => (selector === '[data-chat-turn="3"]' ? rowFor(3) : null),
  querySelectorAll: () => [rowFor(3)],
}
globalThis.document = {
  querySelector: selector => (selector === '[data-conversation-scroll]' ? scrollport : null),
  addEventListener: () => {},
  removeEventListener: () => {},
}
/** Window listeners the components install, so the checks can fire them. */
const listeners = new Map()
const target = {
  addEventListener: (type, handler) => {
    const set = listeners.get(type) ?? new Set()
    set.add(handler)
    listeners.set(type, set)
  },
  removeEventListener: (type, handler) => { listeners.get(type)?.delete(handler) },
}
globalThis.window = { innerWidth: 1280, addEventListener: target.addEventListener, removeEventListener: target.removeEventListener }
/** Fire one window event at every current listener. @param type - event name. @param event - event payload. */
const fire = (type, event) => { for (const handler of [...(listeners.get(type) ?? [])]) handler(event) }
// The Host publishes the composer height on the scrollport; the panel subtracts it.
globalThis.getComputedStyle = () => ({ getPropertyValue: name => (name === '--dsh-composer-height' ? '180px' : '') })
globalThis.requestAnimationFrame = fn => { fn(); return 1 }
globalThis.cancelAnimationFrame = () => {}
globalThis.ResizeObserver = class ResizeObserver {
  /** @param handler - size-change callback. */
  constructor(handler) { this.handler = handler }
  observe() {}
  disconnect() {}
}

const rt = createMiniReact()
const api = await importPluginClient(rt.React)

// ── Stub services and the context the plugin is applied to ──────────────────
const calls = { fork: [], renames: [], archive: [], open: [], rpc: [], loadThrough: [] }
const sourceTitle = '一个相当长的中文会话标题用来测试字节截断是否会吃掉时间戳后缀'
/** The catalogued sessions; `fork` adds the child with the inherited title, as the Host does. */
const catalog = { byId: { 'session-1': { title: sourceTitle } } }
const services = {
  sessions: {
    list: { getSnapshot: () => catalog },
    fork: async (opts) => {
      calls.fork.push(opts)
      catalog.byId['session-child'] = { title: catalog.byId['session-1'].title }
      return 'session-child'
    },
    using: async (id, options, operation) => {
      calls.renames.push({ id, source: options.source })
      return operation({
        binding: {
          session: {
            rename: async (title) => {
              calls.renames.push({ id, title })
              return { ok: true, value: { title } }
            },
            loadThrough: async (seq) => { calls.loadThrough.push(seq) },
          },
        },
      })
    },
  },
  uiWorkspace: {
    archiveSession: async id => { calls.archive.push(id) },
    openSession: id => { calls.open.push(id) },
  },
  connection: {
    rpc: {
      call: async (channel, endpoint, payload) => {
        calls.rpc.push({ channel, endpoint, payload })
        // Wire shape: the carrier result wraps the business result.
        const business = endpoint === 'revise-chan/plan'
          ? { ok: true, value: { turn: 3, forkSeq: 41, messageTime: 1_700_000_000_000 } }
          : { ok: true, value: { turn: 3, seq: 9 } }
        return { ok: true, value: business }
      },
    },
  },
}

const registrations = []
const baseGet = name => services[name]
const ctx = {
  effect: fn => { fn(); return () => {} },
  locale: {
    register: () => () => {},
    bind: () => (key, params) => `${key}${params === undefined ? '' : JSON.stringify(params)}`,
  },
  slots: {
    inject: (name, callback) => { callback(); return () => {} },
    register: (options, component) => {
      assert(typeof options.id === 'string' || typeof options.key === 'string', `registration into ${options.name} needs an id or key`)
      registrations.push({ ...options, component })
      return () => {}
    },
  },
  get: baseGet,
}
api.apply(ctx)
const bySlot = name => registrations.filter(row => row.name === name)

check('the plugin declares only the seats it uses', () => assertEqual(api.inject, ['slots', 'locale'], 'inject list differs'))
check('every contribution lands in its published seat', () => {
  assertEqual(registrations.map(row => `${row.name}:${row.id ?? row.key}`), [
    'conversation.chat.assistant-actions:revise-chan-byline',
    'conversation.chat.assistant-actions:revise-chan-edit',
    'shell.overlay:revise-chan-editor',
    'conversation.input.dock:revise-chan-outline-bridge',
    'shell.overlay:revise-chan-outline',
  ], 'contributions differ')
})

// ── The answer byline and the pencil ───────────────────────────────────────
const t = (key, params) => `${key}${params === undefined ? '' : JSON.stringify(params)}`
/** One finalized answer as the Chat fold would report it. */
const tail = {
  turn: 3,
  seq: 42,
  time: 1_700_000_000_000,
  closing: { blocks: [{ kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'the answer' }], finalNode: { messageId: 'msg-9' } },
  tokenUsage: { routes: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
}
const snapshot = { timeline: { turns: new Map([[3, { data: new Map([['turn-tail', tail]]) }]]) }, navigation: { items: () => [] } }
const useChat = selector => selector(snapshot)
const useSession = selector => selector({ running: false })
const bylineRow = bySlot('conversation.chat.assistant-actions')[0]
const editRow = bySlot('conversation.chat.assistant-actions')[1]

check('the byline reads "<model> | <provider>" after the clock', () => {
  const byline = rt.render(bylineRow.component, { t, messageId: 'msg-9', useChat })
  assertEqual(byline.props.children[1].props.children, ['· deepseek-chat | deepseek'], 'byline text differs')
})
check('the byline stays hidden while the route is unknown', () => {
  const blind = {
    timeline: { turns: new Map([[3, { data: new Map([['turn-tail', { ...tail, tokenUsage: undefined }]]) }]]) },
    navigation: { items: () => [] },
  }
  const tree = rt.render(bylineRow.component, { t, messageId: 'msg-9', useChat: selector => selector(blind) })
  assertEqual(tree, null, 'an unknown route still rendered a byline')
})
check('the pencil is disabled while the agent runs', () => {
  const idle = rt.render(editRow.component, { t, messageId: 'msg-9', sessionId: 'session-1', useChat, useSession, openEditor: () => {} })
  const busy = rt.render(editRow.component, { t, messageId: 'msg-9', sessionId: 'session-1', useChat, useSession: selector => selector({ running: true }), openEditor: () => {} })
  assertEqual([idle.props.children[1].props.disabled, busy.props.children[1].props.disabled], [false, true], 'disabled states differ')
})

// ── The editor dialog ──────────────────────────────────────────────────────
const editorRow = bySlot('shell.overlay')[0]
const editorFace = editorRow.inject()
/**
 * The renderer's bound-observable hook contract: a selector is mandatory.
 * @param selector - selector the component passes.
 */
const useEditor = selector => {
  if (typeof selector !== 'function') throw new Error('selector is not a function')
  return selector(editorFace.hooks.editor.getSnapshot())
}
check('the pencil hands the draft to the dialog', () => {
  const tree = rt.render(editRow.component, {
    t, messageId: 'msg-9', sessionId: 'session-1', useChat, useSession, openEditor: request => { editorFace.hooks.editor.set(request) },
  })
  tree.props.children[1].props.onClick()
  const draft = editorFace.hooks.editor.getSnapshot()
  assertEqual([draft.sessionId, draft.messageId, draft.text, draft.turn], ['session-1', 'msg-9', 'the answer', 3], 'draft differs')
  const overlay = rt.render(editorRow.component, { t, useEditor, ...editorFace })
  // The overlay returns the dialog element; render it so its hooks exist.
  const panel = rt.render(overlay.type, { t, ...overlay.props }).props.children[2]
  assertEqual([panel.props.role, panel.props.children[3].type, panel.props.children[3].props.value], ['dialog', 'textarea', 'the answer'], 'dialog differs')
})

// ── The floating outline ───────────────────────────────────────────────────
const bridgeRow = bySlot('conversation.input.dock')[0]
const outlineRow = bySlot('shell.overlay')[1]
const bridgeFace = bridgeRow.inject()
const outlineFace = outlineRow.inject()
/** @param selector - selector the component passes. */
const useOutline = selector => selector(outlineFace.hooks.outline.getSnapshot())

/**
 * Paint the outline with its panel open.
 * @returns the painted tree, which carries the panel at `children[2]`.
 */
const openOutline = () => {
  const closed = paintOutline()
  if (closed.props.children.length === 2) closed.props.children[1].props.onClick()
  return paintOutline()
}
const bridgeProps = {
  t,
  sessionId: 'session-1',
  useProjection: () => [
    { turn: 1, seq: 5, prompt: 'first question', response: 'first answer' },
    { turn: 3, seq: 40, prompt: 'third question', response: 'third answer' },
  ],
  useChat,
  ...bridgeFace,
}
const outlineProps = { t, useOutline, ...outlineFace }
/**
 * Render the floating outline the way React does: the first pass runs the
 * anchor effect, the pass after its state commit paints the toggle.
 * @returns the painted tree.
 */
const paintOutline = () => {
  rt.render(outlineRow.component, outlineProps)
  return rt.render(outlineRow.component, outlineProps)
}

check('the bridge renders nothing but publishes the turn list', () => {
  assertEqual(rt.render(bridgeRow.component, bridgeProps), null, 'the bridge rendered markup')
  const published = outlineFace.hooks.outline.getSnapshot()
  assert(Array.isArray(published.turns) && published.turns.length === 2, 'the bridge did not publish its turns')
  assert(typeof published.jump === 'function', 'the bridge published no jump')
})
check('the floating outline stays hidden without a published session', () => {
  outlineFace.hooks.outline.set(null)
  assertEqual(paintOutline(), null, 'the outline rendered without a session')
  rt.render(bridgeRow.component, bridgeProps)
})
check('the toggle appears, opens the panel, and lists every turn', () => {
  const closed = paintOutline()
  const button = closed.props.children[1]
  assertEqual([button.props.className, typeof button.props.style.top, typeof button.props.style.right], ['dshReviseChan-floatButton', 'string', 'string'], 'the toggle differs')
  button.props.onClick()
  const opened = paintOutline()
  const panel = opened.props.children[2]
  assertEqual(panel.props.role, 'navigation', 'the panel differs')
  const rows = panel.props.children[1].props.children[0]
  assertEqual(rows.length, 2, 'the panel did not list both turns')
  assertEqual(rows[0].props.children[0].props.children, ['first question'], 'prompt preview differs')
  assertEqual(rows[1].props.children[1].props.children, ['third answer'], 'response preview differs')
  assertEqual(rows[0].props.title.startsWith('outline.turn'), true, 'the row does not name its turn')
  assertEqual(opened.props.children[2].props.style.height, '404px', 'the panel does not use the conversation band')
})
check('the active turn is highlighted from the scrollport rows', () => {
  const opened = paintOutline()
  const rows = opened.props.children[2].props.children[1].props.children[0]
  assertEqual(rows.map(row => row.props['data-active'] === true), [false, true], 'the active-turn highlight differs')
})
check('picking a turn outside the window pages it in, then scrolls to it', async () => {
  const opened = paintOutline()
  const rows = opened.props.children[2].props.children[1].props.children[0]
  rows[1].props.onClick()
  // The jump awaits its paging request, so let the microtasks settle.
  await new Promise(resolve => setTimeout(resolve, 0))
  assertEqual(calls.loadThrough, [40], `the jump did not page the turn in: ${JSON.stringify(calls.loadThrough)}`)
  assertEqual(scrolled, [[3, 'start']], `the jump did not scroll to the turn: ${JSON.stringify(scrolled)}`)
})
check('closing the panel keeps the toggle', () => {
  const opened = paintOutline()
  opened.props.children[2].props.children[0].props.children[1].props.onClick()
  const closed = paintOutline()
  assertEqual(closed.props.children.length, 2, 'the panel did not close')
})
check('a preview-less turn still reads as a turn', () => {
  rt.render(bridgeRow.component, {
    ...bridgeProps,
    useProjection: () => [{ turn: 1, seq: 5, prompt: '', response: '' }],
  })
  const rows = openOutline().props.children[2].props.children[1].props.children[0]
  // The Response slot is passed as `null` (React drops it); only the label renders.
  assertEqual(rows[0].props.children.filter(child => child !== null).length, 1, 'the fallback row carries more than the label')
  assertEqual(rows[0].props.children[0].props.children, ['outline.turn{"turn":1}'], 'the fallback label differs')
  rt.render(bridgeRow.component, bridgeProps)
})
check('a press outside the open outline collapses it', () => {
  const first = openOutline()
  assertEqual(first.props.children.length, 3, 'the panel did not open')
  // Every render mints fresh elements and the panel's ref follows the newest, so
  // each press is aimed with a target read from the tree it is fired against.
  fire('pointerdown', { target: first.props.children[1] })
  const second = paintOutline()
  assertEqual(second.props.children.length, 3, 'a press on the toggle collapsed the panel')
  const rowOfSecond = second.props.children[2].props.children[1].props.children[0][0]
  fire('pointerdown', { target: rowOfSecond })
  const third = paintOutline()
  assertEqual(third.props.children.length, 3, 'a press inside the panel collapsed it')
  fire('pointerdown', { target: { nodeName: 'BODY' } })
  assertEqual(paintOutline().props.children.length, 2, 'a press outside did not collapse the panel')
})
check('unmounting the conversation withdraws the outline', () => {
  rt.unmount(bridgeRow.component)
  assertEqual(outlineFace.hooks.outline.getSnapshot(), null, 'the bridge did not withdraw its payload')
  assertEqual(paintOutline(), null, 'the outline outlived its conversation')
  rt.render(bridgeRow.component, bridgeProps)
})

// ── The revision transaction ───────────────────────────────────────────────
const saved = await editorFace.saveRevision({ sessionId: 'session-1', messageId: 'msg-9', turn: 3 }, 'REVISED answer')
check('saving asks the Host where to cut, then forks there', () => {
  assertEqual(saved, 'session-child', 'saveRevision did not return the branch')
  assertEqual(calls.rpc[0], {
    channel: '/api',
    endpoint: 'revise-chan/plan',
    payload: { args: { request: { sessionId: 'session-1', messageId: 'msg-9' } } },
  }, 'plan call differs')
  assertEqual(calls.fork, [{ sessionId: 'session-1', atSeq: 41 }], 'fork call differs')
})
check('saving then asks the Host to append the revised turn in the branch', () => {
  assertEqual(calls.rpc[1], {
    channel: '/api',
    endpoint: 'revise-chan/revise',
    payload: { args: { request: { sourceSessionId: 'session-1', childSessionId: 'session-child', messageId: 'msg-9', text: 'REVISED answer' } } },
  }, 'revise call differs')
})
check('the branch keeps the title and the superseded session carries the edit time', () => {
  const stamped = calls.renames.filter(row => row.title !== undefined)
  assertEqual(stamped.map(row => row.id), ['session-1'], `only the superseded session is renamed: ${JSON.stringify(stamped)}`)
  assert(/·\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(stamped[0].title), `the superseded title has no stamp: ${stamped[0].title}`)
  assert(stamped[0].title.startsWith('一个相当长的中文会话标题用来测试字节截断'), `the base title was dropped: ${stamped[0].title}`)
  assert(new TextEncoder().encode(stamped[0].title).length <= 80, `title exceeds the session-title byte budget: ${stamped[0].title}`)
  const sources = calls.renames.filter(row => row.source !== undefined)
  assertEqual([...new Set(sources.map(row => row.source))], ['revise-chan'], 'reference source differs')
})
check('the source is archived and the branch opened', () => {
  assertEqual([calls.archive, calls.open], [['session-1'], ['session-child']], 'archive/open differ')
})

const failing = { rpc: { call: async () => ({ ok: true, value: { ok: false, error: { code: 'no-prompt', message: 'x' } } }) } }
ctx.get = name => (name === 'connection' ? failing : baseGet(name))
let failure
try {
  await editorFace.saveRevision({ sessionId: 'session-1', messageId: 'msg-9' }, 'x')
} catch (error) {
  failure = error
}
check('the dialog surfaces a Host business failure', () => assertEqual(failure?.message, 'error.noPrompt', 'failure text differs'))

rt.reset()
await Promise.all(pending)
for (const row of checks) console.log(`${row.ok ? '✔' : '✘'} ${row.name}${row.ok ? '' : ` — ${row.error}`}`)
const failed = checks.filter(row => !row.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
