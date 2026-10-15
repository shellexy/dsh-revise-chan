#!/usr/bin/env node
/**
 * Verify the Browser half without a browser: apply the plugin to a stub context,
 * call every registered entry with realistic slot props, and drive the real
 * `saveRevision` transaction against stub session services.
 *
 * The React stand-in evaluates components as plain functions, so the checks see
 * the element trees and the values that reach the Host Remote; rendering itself
 * is out of scope here (see tools/README.md).
 *
 * Usage: `node tools/verify-client.mjs`
 * @module tools/verify-client
 */

import { importPluginClient } from './lib/dsh-modules.mjs'

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

/** @param condition - value that must be truthy. @param message - failure description. */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// Browser globals the module touches at load time.
globalThis.requestAnimationFrame = fn => { fn(); return 1 }
globalThis.cancelAnimationFrame = () => {}
globalThis.document = { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} }

const api = await importPluginClient()

// ── Stub services and the context the plugin is applied to ──────────────────
const calls = { fork: [], renames: [], archive: [], open: [], rpc: [] }
const services = {
  sessions: {
    list: { getSnapshot: () => ({ byId: { 'session-1': { title: '一个相当长的中文会话标题用来测试字节截断是否会吃掉时间戳后缀' } } }) },
    fork: async opts => { calls.fork.push(opts); return 'session-child' },
    using: async (id, options, operation) => {
      calls.renames.push({ id, source: options.source })
      return operation({
        binding: {
          session: {
            rename: async (title) => {
              calls.renames.push({ id, title })
              return { ok: true, value: { title } }
            },
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
  sidebarRight: { openTab: kind => { calls.tabOpened = kind } },
  sidebarRightTabs: {
    register: definition => { services.tabDefinition = definition; return () => {} },
    get: () => services.tabDefinition,
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

// ── Registration shape ─────────────────────────────────────────────────────
check('the plugin declares only the seats it uses', () => assertEqual(api.inject, ['slots', 'locale'], 'inject list differs'))
check('every contribution lands in its published seat', () => {
  assertEqual(registrations.map(row => `${row.name}:${row.id ?? row.key}`), [
    'conversation.chat.assistant-actions:revise-chan-byline',
    'conversation.chat.assistant-actions:revise-chan-edit',
    'shell.overlay:revise-chan-editor',
    'conversation.session.header.utilities:revise-chan-outline',
    'sidebar.right.pane.tab:dsh-revise-chan-outline',
    'sidebar.right.pane.tab.title:dsh-revise-chan-outline',
  ], 'contributions differ')
})
check('the outline page type registers with the registry', () => {
  assertEqual([services.tabDefinition.id, services.tabDefinition.kind, services.tabDefinition.priority], ['dsh-revise-chan-outline', 'revise-chan-outline', 'builtin'], 'page type differs')
})

// ── Rendering through the entries ──────────────────────────────────────────
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
const t = (key, params) => `${key}${params === undefined ? '' : JSON.stringify(params)}`
const render = (row, props) => row.component({ t, ...props })

check('the byline reads "<model> | <provider>" after the clock', () => {
  const byline = render(bySlot('conversation.chat.assistant-actions')[0], { messageId: 'msg-9', useChat })
  assertEqual(byline.props.children[1].props.children, ['· deepseek-chat | deepseek'], 'byline text differs')
})
check('the byline stays hidden while the route is unknown', () => {
  const blind = { timeline: { turns: new Map([[3, { data: new Map([['turn-tail', { ...tail, tokenUsage: undefined, closing: { ...tail.closing, finalNode: { messageId: 'msg-9' } } }]]) }]]) }, navigation: { items: () => [] } }
  const hidden = render(bySlot('conversation.chat.assistant-actions')[0], { messageId: 'msg-9', useChat: selector => selector(blind) })
  assert(hidden === null, 'an unknown route still rendered a byline')
})
check('the pencil is disabled while the agent runs', () => {
  const row = bySlot('conversation.chat.assistant-actions')[1]
  const idle = render(row, { messageId: 'msg-9', sessionId: 'session-1', useChat, useSession, openEditor: () => {} })
  const busy = render(row, { messageId: 'msg-9', sessionId: 'session-1', useChat, useSession: selector => selector({ running: true }), openEditor: () => {} })
  assertEqual([idle.props.children[1].props.disabled, busy.props.children[1].props.disabled], [false, true], 'disabled states differ')
})
check('the pencil hands the dialog the answer text and turn', () => {
  let opened
  const row = bySlot('conversation.chat.assistant-actions')[1]
  const button = render(row, { messageId: 'msg-9', sessionId: 'session-1', useChat, useSession, openEditor: request => { opened = request } }).props.children[1]
  button.props.onClick()
  assertEqual([opened.sessionId, opened.messageId, opened.text, opened.turn], ['session-1', 'msg-9', 'the answer', 3], 'opened request differs')
})

const overlayRow = bySlot('shell.overlay')[0]
const face = overlayRow.inject()
/**
 * The renderer's bound-observable hook contract: a selector is mandatory.
 * @param selector - selector the component passes.
 */
const useEditor = selector => {
  if (typeof selector !== 'function') throw new Error('selector is not a function')
  return selector(face.hooks.editor.getSnapshot())
}
check('the dialog stays closed without a draft', () => {
  assertEqual(render(overlayRow, { useEditor, ...face }), null, 'the overlay rendered without a draft')
})
check('the dialog prefills the answer and names the turn', () => {
  face.hooks.editor.set({ key: 'draft-1', sessionId: 'session-1', messageId: 'msg-9', text: 'the answer', turn: 3 })
  const opened = render(overlayRow, { useEditor, ...face })
  const panel = opened.type(opened.props).props.children[2]
  assertEqual([panel.props.role, panel.props.children[3].type, panel.props.children[3].props.value], ['dialog', 'textarea', 'the answer'], 'dialog differs')
  assert(panel.props.children[0].props.children[0].props.children[0].includes('outline.turn'), 'the title does not name the turn')
})

const headerRow = bySlot('conversation.session.header.utilities')[0]
const headerFace = headerRow.inject()
check('the outline toggle hides when no page type is in force', () => {
  assertEqual(render(headerRow, { ...headerFace, outlineReady: () => false }), null, 'the toggle rendered without a page type')
})
check('the outline toggle opens the outline page', () => {
  render(headerRow, headerFace).props.children[1].props.onClick()
  assertEqual(calls.tabOpened, 'revise-chan-outline', 'openTab got the wrong kind')
})

check('the outline lists every turn with its previews', () => {
  const body = render(bySlot('sidebar.right.pane.tab')[0], {
    sessionId: 'session-1',
    useProjection: () => [{ turn: 1, seq: 5, prompt: 'first question', response: 'first answer' }],
    useChat,
    jump: () => {},
  })
  const rows = body.props.children[2].props.children[0]
  assertEqual(rows.length, 1, 'outline row count differs')
  assertEqual(rows[0].props.children[1].props.children, ['first question'], 'prompt preview differs')
  assertEqual(rows[0].props.children[2].props.children, ['first answer'], 'response preview differs')
})
check('the outline reports an empty session', () => {
  const body = render(bySlot('sidebar.right.pane.tab')[0], { sessionId: 'session-1', useProjection: () => [], useChat, jump: () => {} })
  assert(body.props.children[1].props.children !== undefined, 'the empty state did not render')
})

// ── The revision transaction ───────────────────────────────────────────────
const saved = await face.saveRevision({ sessionId: 'session-1', messageId: 'msg-9', turn: 3 }, 'REVISED answer')
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
check('the branch is stamped with the save time and the source with the answer time', () => {
  const stamped = calls.renames.filter(row => row.title !== undefined)
  assertEqual(stamped.map(row => row.id), ['session-child', 'session-1'], 'rename targets differ')
  assert(/·\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(stamped[0].title), `branch title is not stamped: ${stamped[0].title}`)
  // The source keeps the edited answer's own instant, rendered in local time.
  const answerStamp = (() => {
    const date = new Date(1_700_000_000_000)
    const pad = value => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  })()
  assert(stamped[1].title.endsWith(`·${answerStamp}`), `source title is not stamped with the answer time: ${stamped[1].title}`)
  for (const row of stamped) {
    assert(new TextEncoder().encode(row.title).length <= 80, `title exceeds the session-title byte budget: ${row.title}`)
  }
  const sources = calls.renames.filter(row => row.source !== undefined)
  assertEqual([...new Set(sources.map(row => row.source))], ['revise-chan'], 'reference source differs')
})
check('the source is archived and the branch opened', () => {
  assertEqual([calls.archive, calls.open], [['session-1'], ['session-child']], 'archive/open differ')
})
const failing = { ...services, connection: { rpc: { call: async () => ({ ok: true, value: { ok: false, error: { code: 'no-prompt', message: 'x' } } }) } } }
ctx.get = name => (name === 'connection' ? failing.connection : baseGet(name))
let failure
try {
  await face.saveRevision({ sessionId: 'session-1', messageId: 'msg-9' }, 'x')
} catch (error) {
  failure = error
}
check('the dialog surfaces a Host business failure', () => assertEqual(failure?.message, 'error.noPrompt', 'failure text differs'))

for (const row of checks) console.log(`${row.ok ? '✔' : '✘'} ${row.name}${row.ok ? '' : ` — ${row.error}`}`)
const failed = checks.filter(row => !row.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
