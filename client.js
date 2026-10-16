/**
 * dsh-revise-chan — Browser half.
 *
 * Three contributions, all through published extension points:
 *
 * 1. `conversation.chat.assistant-actions` — a byline reading
 *    `<model> | <provider>` on the answer's own clock row, and the edit action
 *    beside the built-in copy control.
 * 2. `shell.overlay` — the frame-wide editor dialog the edit action opens. Saving
 *    runs one revision transaction: ask the Host where the branch may cut
 *    (`revise-chan/plan`), fork there, let the Host append the revised turn
 *    (`revise-chan/revise`), then rename the branch, rename and archive the source
 *    session, and open the branch.
 * 3. `sidebar.right.pane.tab` + `conversation.session.header.utilities` — an
 *    always-visible outline page in the right sidebar, with its toggle in the
 *    conversation header.
 *
 * DOM access is limited to two reads the Host publishes for its own anchoring:
 * `[data-conversation-scroll]` for the transcript scrollport and
 * `[data-chat-turn]` for the turn rows. Both are optional: without them the
 * outline still lists every turn, only the jump and the active-turn highlight
 * stay quiet.
 *
 * @module dsh-revise-chan/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-revise-chan',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'revise-chan'
    /** Consumer identity for the session references this plugin retains. */
    const REFERENCE_SOURCE = 'revise-chan'
    /** A trailing `·YYYY-MM-DD HH:mm` this plugin adds, so repeated edits do not stack. */
    const STAMP_SUFFIX = /\s*·\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*$/u
    /** UTF-8 bytes `session-title` accepts for one title (`maxTitleBytes` in the base bundle). */
    const TITLE_BYTES = 80
    /** UTF-8 bytes `·YYYY-MM-DD HH:mm` occupies, kept out of the base's budget so truncation never eats the stamp. */
    const STAMP_BYTES = 18
    const encoder = new TextEncoder()

    /**
     * Clip text to a UTF-8 byte budget without splitting a code point.
     * @param text - normalized title text.
     * @param maxBytes - positive UTF-8 byte budget.
     * @returns the longest leading prefix within the budget.
     */
    function clipBytes(text, maxBytes) {
      if (encoder.encode(text).length <= maxBytes) return text
      let used = 0
      let out = ''
      for (const character of text) {
        const bytes = encoder.encode(character).length
        if (used + bytes > maxBytes) break
        used += bytes
        out += character
      }
      return out.trimEnd()
    }

    const zh = {
      'action.edit': '编辑回答',
      'action.busy': '正在生成回答，稍后再编辑',
      'byline.label': '{model} | {provider}',
      'outline.title': '大纲',
      'outline.open': '大纲：悬浮显示在每个轮次的列表',
      'outline.empty': '这个会话还没有已开始的轮次。',
      'outline.turn': '第 {turn} 轮',
      'outline.jump': '跳到第 {turn} 轮',
      'outline.pending': '尚未载入，点击后载入该轮',
      'outline.current': '当前所在轮次',
      'outline.close': '关闭大纲',
      'dialog.title': '编辑 AI 回答',
      'dialog.hint': '保存后会从这条回答的提问处新建分支：新分支沿用原标题，里面这条回答是你改写的正文；旧会话加上修改时间后缀并归档。',
      'dialog.label': '回答正文',
      'dialog.save': '保存并新建分支',
      'dialog.saving': '正在新建分支…',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.empty': '正文为空时，新分支里的这条回答也会留空。',
      'untitled': '未命名会话',
      'error.unavailable': '当前界面没有提供修订所需的会话服务。',
      'error.sessionNotFound': '找不到这个会话（它可能已关闭或归档）。',
      'error.messageNotFound': '找不到这条回答，它可能已被压缩摘要取代。',
      'error.noPrompt': '这一轮没有可继承的用户提问，无法修订。',
      'error.generic': '修订失败：{message}',
    }

    const en = {
      'action.edit': 'Edit answer',
      'action.busy': 'Answer is still generating; edit once it settles',
      'byline.label': '{model} | {provider}',
      'outline.title': 'Outline',
      'outline.open': 'Outline: the turn list, floating over the conversation',
      'outline.empty': 'This session has no started turn yet.',
      'outline.turn': 'Turn {turn}',
      'outline.jump': 'Jump to turn {turn}',
      'outline.pending': 'Not loaded yet; picking it loads the turn',
      'outline.current': 'Current turn',
      'outline.close': 'Close the outline',
      'dialog.title': 'Edit the AI answer',
      'dialog.hint': 'Saving branches from this answer\'s prompt: the branch keeps the original title and carries your rewritten answer; the previous session is stamped with the edit time and archived.',
      'dialog.label': 'Answer text',
      'dialog.save': 'Save and branch',
      'dialog.saving': 'Creating the branch…',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.empty': 'An empty answer text leaves the branch\'s answer empty.',
      'untitled': 'Untitled session',
      'error.unavailable': 'This page does not expose the session services a revision needs.',
      'error.sessionNotFound': 'That session is not available; it may be closed or archived.',
      'error.messageNotFound': 'That answer is gone; a compaction summary may have replaced it.',
      'error.noPrompt': 'That turn has no inherited human prompt, so it cannot be revised.',
      'error.generic': 'Revision failed: {message}',
    }

    // ---------------------------------------------------------------------
    // Shared helpers
    // ---------------------------------------------------------------------

    /**
     * Find the turn footer that owns one finalized assistant message.
     * @param snapshot - live Chat snapshot.
     * @param messageId - durable assistant message identity.
     * @returns the owning `turn-tail` data, when the loaded window holds it.
     */
    function turnTailOf(snapshot, messageId) {
      if (snapshot === null || typeof snapshot !== 'object') return undefined
      const turns = snapshot.timeline === undefined ? undefined : snapshot.timeline.turns
      if (turns === undefined || turns === null || typeof turns.values !== 'function') return undefined
      for (const turn of turns.values()) {
        const data = turn === null || turn === undefined ? undefined : turn.data
        if (data === undefined || typeof data.get !== 'function') continue
        const tail = data.get('turn-tail')
        const closing = tail === undefined || tail === null ? undefined : tail.closing
        const finalNode = closing === undefined || closing === null ? undefined : closing.finalNode
        if (finalNode !== undefined && finalNode !== null && finalNode.messageId === messageId) return tail
      }
      return undefined
    }

    /**
     * Collect the visible prose of one answer.
     * @param tail - owning `turn-tail` data.
     * @returns the reply text, or an empty string.
     */
    function answerTextOf(tail) {
      const blocks = tail === undefined || tail.closing === undefined ? undefined : tail.closing.blocks
      if (!Array.isArray(blocks)) return ''
      const parts = []
      for (const block of blocks) {
        if (block !== null && typeof block === 'object' && block.kind === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
      return parts.join('')
    }

    /**
     * Render one provider/model pair as `model | provider`.
     * @param route - one route record from the Chat or Trajectory fold.
     * @returns the label, or an empty string when the route names nothing.
     */
    function routeText(route) {
      const model = route === null || typeof route !== 'object' || typeof route.model !== 'string' ? '' : route.model
      const provider = route === null || typeof route !== 'object' || typeof route.provider !== 'string' ? '' : route.provider
      if (model === '' && provider === '') return ''
      return model === '' ? provider : provider === '' ? model : `${model} | ${provider}`
    }

    /** Chat snapshot used when a seat is missing, so every component keeps one hook path. */
    const EMPTY_CHAT_SNAPSHOT = {
      timeline: { turns: new Map() },
      navigation: { items: () => [] },
    }

    /**
     * Keep one selector call site whether or not the framework bound its seat.
     * @param useSelector - the slot prop, when the renderer bound it.
     * @returns a callable selector with a fixed hook shape.
     */
    function chatSeat(useSelector) {
      return typeof useSelector === 'function' ? useSelector : pick => pick(EMPTY_CHAT_SNAPSHOT)
    }

    /**
     * Keep one session-selector call site whether or not the seat was bound.
     * @param useSelector - the slot prop, when the renderer bound it.
     * @param fallback - snapshot read when the seat is missing.
     */
    function sessionSeat(useSelector, fallback) {
      return typeof useSelector === 'function' ? useSelector : pick => pick(fallback)
    }

    /**
     * Format one instant the way session stamps read, in the reader's zone.
     * @param milliseconds - Unix epoch milliseconds.
     * @returns `YYYY-MM-DD HH:mm`.
     */
    function stampOf(milliseconds) {
      const date = new Date(milliseconds)
      const pad = value => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * Strip this plugin's own stamp from a title so repeated edits stay readable.
     * @param title - current durable title.
     * @param fallback - copy used when the title is empty.
     * @returns the title text the next stamp is appended to.
     */
    function titleBase(title, fallback) {
      const text = typeof title === 'string' ? title.trim() : ''
      const stripped = text.replace(STAMP_SUFFIX, '').trim()
      const base = stripped === '' ? text : stripped
      const clipped = clipBytes(base, TITLE_BYTES - STAMP_BYTES)
      return clipped === '' ? fallback : clipped
    }

    /**
     * Call one Host Remote endpoint over the shared connection channel.
     * @param rpc - browser RPC caller.
     * @param endpoint - `<service>/<method>` endpoint.
     * @param request - the method's single `request` argument.
     * @returns the Host's business result.
     */
    async function callRemote(rpc, endpoint, request) {
      const result = await rpc.call('/api', endpoint, { args: { request } })
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        const failure = result === null || typeof result !== 'object' ? undefined : result.error
        throw new Error(failure !== undefined && typeof failure.message === 'string' ? failure.message : endpoint)
      }
      return result.value
    }

    /**
     * Map one Host failure onto localized copy.
     * @param result - failed business result.
     * @param t - translator of this plugin's namespace.
     * @returns the message the dialog shows.
     */
    function failureText(result, t) {
      const error = result === null || typeof result !== 'object' ? undefined : result.error
      const code = error === undefined ? undefined : error.code
      const message = error === undefined || typeof error.message !== 'string' ? '' : error.message
      if (code === 'session-not-found') return t('error.sessionNotFound')
      if (code === 'message-not-found') return t('error.messageNotFound')
      if (code === 'no-prompt') return t('error.noPrompt')
      return t('error.generic', { message: message === '' ? String(code ?? '') : message })
    }

    /** One live value with a stable identity between changes. */
    function createSnapshotSource(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Resolve after the browser has painted two frames. */
    function twoFrames() {
      return new Promise((resolve) => {
        requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
      })
    }

    /**
     * Scroll the transcript to one turn's first row.
     *
     * `[data-conversation-scroll]` and `[data-chat-turn]` are the anchors the
     * Chat view publishes for its own navigation; when a later version renames
     * them this quietly does nothing.
     * @param turn - turn number to reveal.
     * @returns completion of the best-effort reveal.
     */
    async function revealTurn(turn) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const container = document.querySelector('[data-conversation-scroll]')
        const row = container === null ? null : container.querySelector(`[data-chat-turn="${turn}"]`)
        if (row !== null && typeof row.scrollIntoView === 'function') {
          row.scrollIntoView({ block: 'start', behavior: attempt === 0 ? 'smooth' : 'auto' })
          return
        }
        await twoFrames()
      }
    }

    // ---------------------------------------------------------------------
    // Icons and shared styles
    // ---------------------------------------------------------------------

    /** @param props - `{ size }` in CSS pixels. */
    function IconPencil(props) {
      const size = props.size === undefined ? 16 : props.size
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      }, h('path', {
        d: 'M10.9 2.6a1.4 1.4 0 0 1 2 2L5.7 11.8l-2.6.8.8-2.6 7-7.4Z',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
      }))
    }

    /** @param props - `{ size }` in CSS pixels. */
    function IconOutline(props) {
      const size = props.size === undefined ? 16 : props.size
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      },
      h('path', { d: 'M3 3.5h10M3 8h10M3 12.5h6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    }

    /** @param props - `{ size }` in CSS pixels. */
    function IconClose(props) {
      const size = props.size === undefined ? 14 : props.size
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
      }, h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    const ACTION_CSS = `
.dshReviseChan-action {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary, currentColor);
  cursor: pointer;
}
.dshReviseChan-action:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary, currentColor); }
.dshReviseChan-action:disabled { cursor: default; opacity: .45; }
.dshReviseChan-action:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: 1px; }
.dshReviseChan-byline {
  order: 5; align-self: center; white-space: nowrap;
  font-size: 12px; line-height: 20px;
  color: var(--dsw-alias-label-secondary, currentColor);
}
`

    // ---------------------------------------------------------------------
    // Answer byline: "<model> | <provider>" on the answer's own clock row
    // ---------------------------------------------------------------------

    /**
     * The byline entry of one finalized assistant message.
     * @param props - owner message identity plus the session seats.
     * @returns the byline span, or nothing when the route is unknown.
     */
    function BylineAction(props) {
      const useChat = chatSeat(props.useChat)
      const messageId = props.messageId
      const byline = useChat((snapshot) => {
        const tail = turnTailOf(snapshot, messageId)
        if (tail === undefined) return ''
        // The Chat fold reports the route on the Turn's token accounting; the
        // Trajectory fold reports it per message. Either may be the one this
        // assembly populates.
        const closing = tail.closing
        const finalNode = closing === undefined ? undefined : closing.finalNode
        const meta = finalNode === undefined ? undefined : finalNode.providerMetadata
        const direct = meta === undefined || meta === null ? '' : routeText(meta)
        if (direct !== '') return direct
        const usage = tail.tokenUsage
        const routes = usage === undefined || usage === null ? undefined : usage.routes
        if (!Array.isArray(routes)) return ''
        return routes.map(routeText).filter(text => text !== '').join(', ')
      })
      if (byline === '') return null
      return h(React.Fragment, null,
        h('style', { key: 'style' }, ACTION_CSS),
        h('span', { key: 'byline', className: 'dshReviseChan-byline', title: byline }, `· ${byline}`))
    }

    // ---------------------------------------------------------------------
    // Edit action: the pencil beside the copy control
    // ---------------------------------------------------------------------

    /**
     * The edit entry of one finalized assistant message.
     * @param props - owner message identity, session seats, and the injected opener.
     * @returns the pencil button.
     */
    function EditAction(props) {
      const useChat = chatSeat(props.useChat)
      const useSession = sessionSeat(props.useSession, { running: false })
      const messageId = props.messageId
      const sessionId = props.sessionId
      const openEditor = props.openEditor
      const t = props.t
      const running = useSession(snapshot => snapshot !== null && typeof snapshot === 'object' && snapshot.running === true)
      const text = useChat(snapshot => answerTextOf(turnTailOf(snapshot, messageId)))
      const turn = useChat((snapshot) => {
        const tail = turnTailOf(snapshot, messageId)
        return tail === undefined || typeof tail.turn !== 'number' ? 0 : tail.turn
      })
      const onOpen = useCallback(() => {
        if (typeof openEditor !== 'function' || typeof sessionId !== 'string' || typeof messageId !== 'string') return
        openEditor({
          key: `${sessionId}:${messageId}:${String(Date.now())}`,
          sessionId,
          messageId,
          text,
          turn,
        })
      }, [openEditor, sessionId, messageId, text, turn])
      const label = running ? t('action.busy') : t('action.edit')
      return h(React.Fragment, null,
        h('style', { key: 'style' }, ACTION_CSS),
        h('button', {
          key: 'edit',
          type: 'button',
          className: 'dshReviseChan-action',
          'aria-label': label,
          title: label,
          disabled: running,
          onClick: onOpen,
        }, h(IconPencil, { size: 15 })))
    }

    // ---------------------------------------------------------------------
    // Editor dialog, seated in the frame-wide overlay layer
    // ---------------------------------------------------------------------

    const DIALOG_CSS = `
.dshReviseChan-layer {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: 24px; pointer-events: auto;
}
.dshReviseChan-mask {
  position: absolute; inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 32%));
  backdrop-filter: var(--dsw-mask-blur, none);
}
.dshReviseChan-dialog {
  position: relative; z-index: 1; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 12px;
  width: min(720px, 100%); max-height: 100%; padding: 18px 20px 20px;
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, canvas));
  color: var(--dsw-alias-label-primary, canvastext);
}
.dshReviseChan-head { display: flex; align-items: flex-start; gap: 12px; }
.dshReviseChan-title { flex: 1; margin: 0; font-size: 15px; font-weight: 600; }
.dshReviseChan-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary, currentColor); cursor: pointer;
}
.dshReviseChan-close:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary, currentColor); }
.dshReviseChan-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, currentColor); }
.dshReviseChan-fieldLabel { font-size: 12px; color: var(--dsw-alias-label-secondary, currentColor); }
.dshReviseChan-text {
  box-sizing: border-box; width: 100%; min-height: 240px; max-height: 52vh; resize: vertical;
  padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, transparent); border-radius: 10px;
  background: var(--dsw-alias-bg-base, canvas); color: var(--dsw-alias-label-primary, canvastext);
  font-family: inherit; font-size: 13px; line-height: 20px;
}
.dshReviseChan-text:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: -1px; }
.dshReviseChan-foot { display: flex; align-items: center; gap: 10px; }
.dshReviseChan-status { flex: 1; font-size: 12px; color: var(--dsw-alias-label-secondary, currentColor); }
.dshReviseChan-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary, currentColor); }
.dshReviseChan-button {
  box-sizing: border-box; height: 32px; padding: 0 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, transparent);
  background: transparent; color: var(--dsw-alias-label-primary, canvastext); font-size: 13px;
}
.dshReviseChan-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); }
/* The filled variant keeps a fill on hover: swapping the background for a
   surface token while the foreground stays a fill-contrast color is what made
   the label vanish under the pointer. */
.dshReviseChan-button[data-primary] {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, currentColor));
  color: var(--dsw-alias-label-primary-foreground, canvas);
}
.dshReviseChan-button[data-primary]:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, currentColor)));
}
.dshReviseChan-button:disabled { cursor: default; opacity: .6; }
`

    /**
     * The frame-wide editor host: one live request at a time.
     * @param props - injected editor source and the save transaction.
     * @returns the dialog, or nothing while no request is open.
     */
    function EditorOverlay(props) {
      const useEditor = typeof props.useEditor === 'function' ? props.useEditor : select => select(null)
      // A bound observable hook always takes a selector: calling it bare would
      // throw inside the renderer's uSES bridge and retire this entry.
      const request = useEditor(snapshot => snapshot)
      if (request === undefined || request === null) return null
      return h(EditorDialog, {
        key: request.key === undefined ? 'revise-chan-editor' : request.key,
        request,
        save: props.saveRevision,
        close: props.closeEditor,
        t: props.t,
      })
    }

    /**
     * One revision draft: the answer text the reader is rewriting.
     * @param props - request facts, the save transaction, dismissal, translator.
     * @returns the modal dialog.
     */
    function EditorDialog(props) {
      const { request, save, close, t } = props
      const [text, setText] = useState(typeof request.text === 'string' ? request.text : '')
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState('')
      const field = useRef(null)
      useEffect(() => {
        const node = field.current
        if (node !== null && typeof node.focus === 'function') node.focus()
      }, [])
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (!busy && typeof close === 'function') close()
        }
        window.addEventListener('keydown', onKey, true)
        return () => { window.removeEventListener('keydown', onKey, true) }
      }, [busy, close])
      const onSave = useCallback(async () => {
        if (busy || typeof save !== 'function') return
        setBusy(true)
        setProblem('')
        try {
          await save(request, text)
          if (typeof close === 'function') close()
        } catch (error) {
          setProblem(error !== null && typeof error === 'object' && typeof error.message === 'string'
            ? error.message
            : String(error))
          setBusy(false)
        }
      }, [busy, save, request, text, close])
      return h('div', { className: 'dshReviseChan-layer' },
        h('style', null, DIALOG_CSS),
        h('div', { className: 'dshReviseChan-mask', 'aria-hidden': true }),
        h('div', {
          className: 'dshReviseChan-dialog',
          role: 'dialog',
          'aria-modal': true,
          'aria-label': t('dialog.title'),
        },
        h('div', { className: 'dshReviseChan-head' },
          h('h2', { className: 'dshReviseChan-title' },
            request.turn === undefined || request.turn === 0 || typeof request.turn !== 'number'
              ? t('dialog.title')
              : `${t('dialog.title')} · ${t('outline.turn', { turn: request.turn })}`),
          h('button', {
            type: 'button',
            className: 'dshReviseChan-close',
            'aria-label': t('dialog.close'),
            title: t('dialog.close'),
            disabled: busy,
            onClick: () => { if (typeof close === 'function') close() },
          }, h(IconClose, { size: 14 }))),
        h('p', { className: 'dshReviseChan-hint' }, t('dialog.hint')),
        h('span', { className: 'dshReviseChan-fieldLabel' }, t('dialog.label')),
        h('textarea', {
          ref: field,
          className: 'dshReviseChan-text',
          value: text,
          spellCheck: false,
          disabled: busy,
          onChange: (event) => { setText(event.target.value) },
        }),
        text === '' ? h('p', { className: 'dshReviseChan-hint' }, t('dialog.empty')) : null,
        h('div', { className: 'dshReviseChan-foot' },
          h('span', {
            className: 'dshReviseChan-status',
            'data-tone': problem === '' ? undefined : 'error',
            role: problem === '' ? undefined : 'alert',
          }, problem === '' ? (busy ? t('dialog.saving') : '') : problem),
          h('button', {
            type: 'button',
            className: 'dshReviseChan-button',
            disabled: busy,
            onClick: () => { if (typeof close === 'function') close() },
          }, t('dialog.cancel')),
          h('button', {
            type: 'button',
            className: 'dshReviseChan-button',
            'data-primary': true,
            disabled: busy,
            onClick: () => { void onSave() },
          }, busy ? t('dialog.saving') : t('dialog.save')))))
    }

    // ---------------------------------------------------------------------
    // Outline: a floating panel over the conversation
    // ---------------------------------------------------------------------

    const OUTLINE_CSS = `
.dshReviseChan-floatButton {
  position: fixed; z-index: 20; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border-radius: 999px; cursor: pointer; pointer-events: auto;
  border: 1px solid var(--dsw-alias-border-l1, transparent);
  background: var(--dsw-alias-bg-layer-1, canvas);
  color: var(--dsw-alias-label-secondary, currentColor);
  box-shadow: var(--dsw-elevation-panel, none);
}
.dshReviseChan-floatButton:hover,
.dshReviseChan-floatButton[data-open] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary, currentColor); }
.dshReviseChan-floatButton:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: 2px; }
.dshReviseChan-floatPanel {
  position: fixed; z-index: 20; display: flex; flex-direction: column;
  /* The height is measured into place (the Conversation band above the composer);
     this clamp only guards a stale measurement. */
  width: 300px; max-height: calc(100vh - 64px); overflow: hidden; pointer-events: auto;
  border: 1px solid var(--dsw-alias-border-l2, transparent); border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, canvas));
  color: var(--dsw-alias-label-primary, canvastext);
  box-shadow: var(--dsw-elevation-panel, none);
}
.dshReviseChan-panelHead {
  display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, transparent);
  font-size: 12px; color: var(--dsw-alias-label-secondary, currentColor);
}
.dshReviseChan-panelTitle { flex: 1; }
.dshReviseChan-panelClose {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border: 0; border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary, currentColor); cursor: pointer;
}
.dshReviseChan-panelClose:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary, currentColor); }
.dshReviseChan-panelList { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; }
.dshReviseChan-outlineEmpty { padding: 16px 12px; font-size: 13px; color: var(--dsw-alias-label-secondary, currentColor); }
.dshReviseChan-outlineRow {
  display: block; width: 100%; box-sizing: border-box; text-align: left; cursor: pointer;
  padding: 6px 9px; margin: 0 0 2px; border: 0; border-left: 2px solid transparent; border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary, canvastext); font: inherit;
}
.dshReviseChan-outlineRow:hover { background: var(--dsw-alias-bg-layer-1); }
.dshReviseChan-outlineRow[data-active] {
  background: var(--dsw-alias-bg-layer-1);
  border-left-color: var(--dsw-alias-brand-primary, currentColor);
}
.dshReviseChan-outlineRow:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: -2px; }
/* One line of question, two of answer: the densest the rail's own previews get. */
.dshReviseChan-outlinePrompt {
  font-size: 13px; line-height: 17px; color: var(--dsw-alias-label-primary, canvastext);
  overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1;
}
.dshReviseChan-outlineResponse {
  margin-top: 2px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary, currentColor);
  overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
}
`

    /**
     * Merge the Host outline projection with the loaded rail items.
     * @param outline - `turnOutline` projection value, treated as wire data.
     * @param loaded - loaded-window navigation items.
     * @returns every known turn, ascending.
     */
    function outlineTurns(outline, loaded) {
      const byTurn = new Map()
      if (Array.isArray(outline)) {
        for (const raw of outline) {
          if (raw === null || typeof raw !== 'object') continue
          if (typeof raw.turn !== 'number' || typeof raw.seq !== 'number') continue
          byTurn.set(raw.turn, {
            turn: raw.turn,
            seq: raw.seq,
            prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
            response: typeof raw.response === 'string' ? raw.response : '',
            loaded: false,
          })
        }
      }
      if (Array.isArray(loaded)) {
        for (const item of loaded) {
          if (item === null || typeof item !== 'object' || typeof item.turn !== 'number') continue
          const known = byTurn.get(item.turn)
          byTurn.set(item.turn, {
            turn: item.turn,
            seq: known === undefined ? undefined : known.seq,
            prompt: typeof item.prompt === 'string' && item.prompt !== ''
              ? item.prompt
              : known === undefined ? '' : known.prompt,
            response: typeof item.response === 'string' && item.response !== ''
              ? item.response
              : known === undefined ? '' : known.response,
            loaded: true,
          })
        }
      }
      return [...byTurn.values()].sort((left, right) => left.turn - right.turn)
    }

    /**
     * Session-scoped bridge for the floating outline.
     *
     * The panel itself renders in the frame-wide `shell.overlay`, which is
     * root-scoped and therefore cannot read this Session's projection or its
     * navigation items. This entry renders nothing; it owns the turn list and
     * the jump closure (the only piece that knows which Session to page in) and
     * publishes them, withdrawing them when the Conversation unmounts.
     *
     * @param props - session seats plus the injected publish and jump.
     * @returns nothing.
     */
    function OutlineBridge(props) {
      const sessionId = props.sessionId
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : () => undefined
      const useChat = chatSeat(props.useChat)
      const publish = props.publish
      const jumpToTurn = props.jumpToTurn
      const outline = useProjection('turnOutline')
      const loaded = useChat(snapshot => (snapshot.navigation === undefined ? [] : snapshot.navigation.items()))
      const turns = useMemo(() => outlineTurns(outline, loaded), [outline, loaded])
      const [active, setActive] = useState(null)
      useEffect(() => {
        let frame = null
        const measure = () => {
          frame = null
          const container = document.querySelector('[data-conversation-scroll]')
          if (container === null) {
            setActive(null)
            return
          }
          const bounds = container.getBoundingClientRect()
          const limit = bounds.top + Math.min(bounds.height * 0.4, 240)
          let current = null
          for (const row of container.querySelectorAll('[data-chat-turn]')) {
            if (row.getBoundingClientRect().top > limit) break
            const turn = Number(row.getAttribute('data-chat-turn'))
            if (Number.isFinite(turn)) current = turn
          }
          setActive(current)
        }
        const schedule = () => {
          if (frame === null) frame = requestAnimationFrame(measure)
        }
        measure()
        document.addEventListener('scroll', schedule, true)
        window.addEventListener('resize', schedule)
        return () => {
          document.removeEventListener('scroll', schedule, true)
          window.removeEventListener('resize', schedule)
          if (frame !== null) cancelAnimationFrame(frame)
        }
      }, [sessionId])
      useEffect(() => {
        publish({ sessionId, turns, active, jump: entry => { void jumpToTurn({ ...entry, sessionId }) } })
      }, [publish, sessionId, turns, active, jumpToTurn])
      useEffect(() => () => { publish(null) }, [publish])
      return null
    }

    /**
     * Frame-wide floating outline: a toggle pinned to the Conversation column's
     * top-right corner and the turn list it shows.
     * @param props - injected outline source, its remembered open flags, translator.
     * @returns the toggle, and the panel while it is open.
     */
    function OutlineFloat(props) {
      const useOutline = typeof props.useOutline === 'function' ? props.useOutline : select => select(null)
      const wasOpen = props.wasOpen
      const rememberOpen = props.rememberOpen
      const t = props.t
      const current = useOutline(snapshot => snapshot)
      const sessionId = current === null || current === undefined ? null : current.sessionId
      const [open, setOpen] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const panelRef = useRef(null)
      const buttonRef = useRef(null)

      // Ride the Conversation column: its scrollport is the anchor the Host
      // publishes, so the toggle follows panel and window size changes.
      useEffect(() => {
        if (sessionId === null) return undefined
        let frame = null
        const measure = () => {
          frame = null
          const container = document.querySelector('[data-conversation-scroll]')
          if (container === null) {
            setAnchor(null)
            return
          }
          const rect = container.getBoundingClientRect()
          // The panel stops above the composer: the Host publishes its height on
          // the scrollport, and 152px is the rail's own fallback.
          const published = Number.parseFloat(getComputedStyle(container).getPropertyValue('--dsh-composer-height'))
          const composer = Number.isFinite(published) && published > 0 ? published : 152
          setAnchor({
            top: Math.round(rect.top + 8),
            right: Math.round(Math.max(8, window.innerWidth - rect.right + 12)),
            height: Math.round(Math.max(240, rect.height - composer - 16)),
          })
        }
        const schedule = () => {
          if (frame === null) frame = requestAnimationFrame(measure)
        }
        measure()
        const container = document.querySelector('[data-conversation-scroll]')
        const observer = typeof ResizeObserver === 'function' && container !== null ? new ResizeObserver(schedule) : null
        if (observer !== null && container !== null) observer.observe(container)
        window.addEventListener('resize', schedule)
        document.addEventListener('scroll', schedule, true)
        return () => {
          window.removeEventListener('resize', schedule)
          document.removeEventListener('scroll', schedule, true)
          if (observer !== null) observer.disconnect()
          if (frame !== null) cancelAnimationFrame(frame)
        }
      }, [sessionId])

      // Each Session remembers whether its outline was open.
      useEffect(() => {
        setOpen(sessionId === null ? false : wasOpen(sessionId) === true)
      }, [sessionId, wasOpen])

      const flip = useCallback(() => {
        setOpen((previous) => {
          const next = !previous
          if (sessionId !== null) rememberOpen(sessionId, next)
          return next
        })
      }, [sessionId, rememberOpen])
      const dismiss = useCallback(() => {
        setOpen(false)
        if (sessionId !== null) rememberOpen(sessionId, false)
      }, [sessionId, rememberOpen])
      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') dismiss() }
        // Any press outside the panel or its toggle takes the outline down; a
        // press inside (a row, the header) leaves it up for the next jump.
        const onPress = (event) => {
          const target = event.target
          if (panelRef.current !== null && panelRef.current.contains(target)) return
          if (buttonRef.current !== null && buttonRef.current.contains(target)) return
          dismiss()
        }
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('pointerdown', onPress, true)
        return () => {
          window.removeEventListener('keydown', onKey, true)
          window.removeEventListener('pointerdown', onPress, true)
        }
      }, [open, dismiss])

      if (current === null || current === undefined || anchor === null) return null
      const toggle = h('button', {
        key: 'toggle',
        ref: buttonRef,
        type: 'button',
        className: 'dshReviseChan-floatButton',
        style: { top: `${String(anchor.top)}px`, right: `${String(anchor.right)}px` },
        title: t('outline.open'),
        'aria-label': t('outline.open'),
        'aria-expanded': open,
        'data-open': open ? true : undefined,
        onClick: flip,
      }, h(IconOutline, { size: 15 }))
      if (!open) {
        return h(React.Fragment, null, h('style', { key: 'style' }, OUTLINE_CSS), toggle)
      }
      const turns = current.turns
      const panel = h('div', {
        key: 'panel',
        ref: panelRef,
        className: 'dshReviseChan-floatPanel',
        style: {
          top: `${String(anchor.top + 36)}px`,
          right: `${String(anchor.right)}px`,
          height: `${String(anchor.height)}px`,
        },
        role: 'navigation',
        'aria-label': t('outline.title'),
      },
      h('div', { className: 'dshReviseChan-panelHead' },
        h('span', { className: 'dshReviseChan-panelTitle' }, `${t('outline.title')} · ${String(turns.length)}`),
        h('button', {
          type: 'button',
          className: 'dshReviseChan-panelClose',
          title: t('outline.close'),
          'aria-label': t('outline.close'),
          onClick: dismiss,
        }, h(IconClose, { size: 13 }))),
      turns.length === 0
        ? h('div', { className: 'dshReviseChan-outlineEmpty' }, t('outline.empty'))
        : h('div', { className: 'dshReviseChan-panelList' },
          turns.map(entry => {
            const label = t('outline.turn', { turn: entry.turn })
            const active = entry.turn === current.active
            const heading = entry.prompt === '' && entry.response === '' ? label : entry.prompt
            return h('button', {
              key: String(entry.turn),
              type: 'button',
              className: 'dshReviseChan-outlineRow',
              'data-active': active ? true : undefined,
              // The number leaves the layout but stays reachable: a preview-less
              // turn still reads as a turn, and every row names itself on hover.
              title: `${label}${active ? ` · ${t('outline.current')}` : ''}`
                + ` — ${entry.loaded ? t('outline.jump', { turn: entry.turn }) : t('outline.pending')}`,
              'aria-label': label,
              'aria-current': active ? 'true' : undefined,
              onClick: () => { void current.jump(entry) },
            },
            heading === '' ? null : h('div', { className: 'dshReviseChan-outlinePrompt' }, heading),
            entry.response === ''
              ? null
              : h('div', { className: 'dshReviseChan-outlineResponse' }, entry.response))
          })))
      return h(React.Fragment, null, h('style', { key: 'style' }, OUTLINE_CSS), toggle, panel)
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-revise-chan: dictionaries')
        const t = ctx.locale.bind(NS)
        const editor = createSnapshotSource(null)
        /** What the Session-scoped bridge publishes for the floating outline. */
        const outline = createSnapshotSource(null)
        /** Per-Session open flags, remembered for this page load only. */
        const outlineOpen = new Map()

        /** @param entry - one outline row. */
        async function jumpToTurn(entry) {
          if (entry === null || typeof entry !== 'object') return
          if (entry.loaded !== true && typeof entry.seq === 'number' && typeof entry.sessionId === 'string') {
            const sessions = ctx.get('sessions')
            if (sessions !== undefined && typeof sessions.using === 'function') {
              try {
                await sessions.using(entry.sessionId, { source: REFERENCE_SOURCE },
                  reference => reference.binding.session.loadThrough(entry.seq))
              } catch (error) {
                // A turn that cannot page in still gets the scroll attempt below,
                // because the loaded window may already hold its row.
              }
            }
          }
          await revealTurn(entry.turn)
        }

        /**
         * Rename one session through its retained reference.
         * @param sessions - client sessions service.
         * @param sessionId - target session.
         * @param title - accepted durable title.
         */
        async function renameSession(sessions, sessionId, title) {
          await sessions.using(sessionId, { source: REFERENCE_SOURCE }, async (reference) => {
            const result = await reference.binding.session.rename(title)
            if (result !== null && typeof result === 'object' && result.ok === false) {
              const error = result.error
              throw new Error(error !== undefined && typeof error.message === 'string' ? error.message : title)
            }
          })
        }

        /**
         * The whole revision transaction behind the dialog's save action.
         * @param request - the open draft's facts.
         * @param text - the edited answer text.
         * @returns the created branch identity.
         */
        async function saveRevision(request, text) {
          const sessions = ctx.get('sessions')
          const uiWorkspace = ctx.get('uiWorkspace')
          const connection = ctx.get('connection')
          const rpc = connection === undefined ? undefined : connection.rpc
          if (sessions === undefined || uiWorkspace === undefined || rpc === undefined) {
            throw new Error(t('error.unavailable'))
          }
          const planned = await callRemote(rpc, 'revise-chan/plan', {
            sessionId: request.sessionId,
            messageId: request.messageId,
          })
          if (planned === null || typeof planned !== 'object' || planned.ok !== true) {
            throw new Error(failureText(planned, t))
          }
          const childId = await sessions.fork({ sessionId: request.sessionId, atSeq: planned.value.forkSeq })
          const revised = await callRemote(rpc, 'revise-chan/revise', {
            sourceSessionId: request.sessionId,
            childSessionId: childId,
            messageId: request.messageId,
            text,
          })
          if (revised === null || typeof revised !== 'object' || revised.ok !== true) {
            throw new Error(failureText(revised, t))
          }
          const byId = sessions.list.getSnapshot().byId
          const current = byId === undefined ? undefined : byId[request.sessionId]
          const base = titleBase(current === undefined ? '' : current.title, t('untitled'))
          // The branch keeps whatever the conversation was called: the reader
          // stays in "the same" conversation. Only the version it supersedes is
          // stamped, and `titleBase` clips it so the stamp fits the Host's byte
          // budget.
          await renameSession(sessions, request.sessionId, `${base}·${stampOf(Date.now())}`)
          await uiWorkspace.archiveSession(request.sessionId)
          uiWorkspace.openSession(childId)
          return childId
        }

        // 1. The answer's byline and its edit action.
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'revise-chan-byline',
          order: 20,
          locale: NS,
        }, BylineAction))
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'revise-chan-edit',
          order: 30,
          locale: NS,
          inject: () => ({ openEditor: (request) => { editor.set(request) } }),
        }, EditAction))

        // 2. The editor dialog, in the frame-wide floating layer.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'revise-chan-editor',
          order: 70,
          locale: NS,
          inject: () => ({
            hooks: { editor },
            saveRevision,
            closeEditor: () => { editor.set(null) },
          }),
        }, EditorOverlay))

        // 3. The outline: a Session-scoped bridge publishes the turn list and the
        //    jump closure; the frame-wide floating panel renders them.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'revise-chan-outline-bridge',
          inject: () => ({ publish: outline.set, jumpToTurn }),
        }, OutlineBridge))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'revise-chan-outline',
          order: 60,
          locale: NS,
          inject: () => ({
            hooks: { outline },
            wasOpen: sessionId => outlineOpen.get(sessionId) === true,
            rememberOpen: (sessionId, open) => { outlineOpen.set(sessionId, open) },
          }),
        }, OutlineFloat))
      },
    }
  },
})
