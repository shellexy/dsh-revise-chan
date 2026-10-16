/**
 * A miniature React runtime for the Browser-half verification.
 *
 * `verify-client.mjs` has no renderer and no DOM, but the plugin's components do
 * use state, effects, refs and memoisation, and the interesting behaviour (the
 * floating outline opening, a row jump, the dialog draft) lives behind those
 * hooks. This runtime implements exactly the hook contract those components
 * rely on: per-component hook cells, dependency comparison for `useMemo` /
 * `useCallback` / `useEffect`, effect cleanups, and a render call the test drives
 * itself after firing an event handler.
 *
 * It is deliberately not React: no scheduling, no reconciliation, no children
 * diffing. `createElement` returns a plain `{ type, props }` tree the test
 * inspects, and the test re-renders explicitly.
 *
 * @module tools/lib/mini-react
 */

/**
 * Compare two dependency lists the way React does.
 * @param left - previous dependencies.
 * @param right - next dependencies.
 * @returns whether every entry is `Object.is`-equal.
 */
function sameDeps(left, right) {
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/**
 * Create one runtime instance.
 * @returns the runtime: `{ React, render, unmount, reset }`.
 */
export function createMiniReact() {
  const instances = new Map()
  let current
  let cursor = 0

  /**
   * The hook store of one component identity.
   * @param component - the component function.
   * @returns its instance record.
   */
  function instanceOf(component) {
    let found = instances.get(component)
    if (found === undefined) {
      found = { cells: [], pending: [] }
      instances.set(component, found)
    }
    return found
  }

  /**
   * Reserve the next hook cell of the component being rendered.
   * @returns that cell.
   */
  function nextCell() {
    const index = cursor
    cursor += 1
    if (current.cells[index] === undefined) current.cells[index] = { kind: 'empty' }
    return current.cells[index]
  }

  const Fragment = Symbol('Fragment')

  /**
   * Attach a ref-like element to a plain element tree node: the node itself is
   * the "DOM node", and `contains` walks its children so outside-press logic is
   * testable without a DOM.
   * @param element - the node just built.
   * @returns the node.
   */
  function attachRef(element) {
    element.contains = target => {
      if (target === element) return true
      return flatten(element.props.children).some(child => child !== null && typeof child === 'object'
        && typeof child.contains === 'function' && child.contains(target))
    }
    const ref = element.props.ref
    if (ref !== null && typeof ref === 'object') ref.current = element
    return element
  }

  /**
   * Flatten a children list the way React renders it.
   * @param children - nested children.
   * @returns every leaf in order.
   */
  function flatten(children) {
    if (!Array.isArray(children)) return [children]
    return children.flatMap(child => flatten(child))
  }

  const React = {
    Fragment,
    createElement: (type, props, ...children) => attachRef({ type, props: { ...(props ?? {}), children } }),
    memo: component => component,
    /** @param initial - state or a lazy initialiser. */
    useState(initial) {
      const cell = nextCell()
      if (cell.kind !== 'state') {
        cell.kind = 'state'
        cell.value = typeof initial === 'function' ? initial() : initial
      }
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
    },
    /** @param initial - initial ref value. */
    useRef(initial) {
      const cell = nextCell()
      if (cell.kind !== 'ref') {
        cell.kind = 'ref'
        cell.value = { current: initial }
      }
      return cell.value
    },
    /**
     * @param factory - value producer.
     * @param deps - dependency list.
     */
    useMemo(factory, deps) {
      const cell = nextCell()
      if (cell.kind !== 'memo' || !sameDeps(cell.deps, deps)) {
        cell.kind = 'memo'
        cell.deps = deps
        cell.value = factory()
      }
      return cell.value
    },
    /**
     * @param fn - callback.
     * @param deps - dependency list.
     */
    useCallback(fn, deps) {
      const cell = nextCell()
      if (cell.kind !== 'callback' || !sameDeps(cell.deps, deps)) {
        cell.kind = 'callback'
        cell.deps = deps
        cell.value = fn
      }
      return cell.value
    },
    /**
     * @param effect - effect body, optionally returning a cleanup.
     * @param deps - dependency list.
     */
    useEffect(effect, deps) {
      const cell = nextCell()
      if (cell.kind !== 'effect') {
        cell.kind = 'effect'
        cell.deps = undefined
        cell.cleanup = undefined
      }
      if (cell.deps === undefined && deps === undefined) {
        // An omitted dependency list re-runs on every render.
        cell.deps = undefined
        cell.rerun = true
      } else if (!sameDeps(cell.deps, deps)) {
        cell.deps = deps
        cell.rerun = true
      }
      cell.effect = effect
      if (cell.rerun === true) current.pending.push(cell)
    },
  }

  /**
   * Render one component and flush the effects it scheduled.
   * @param component - component function.
   * @param props - props for this render.
   * @returns the element tree the component returned.
   */
  function render(component, props) {
    const instance = instanceOf(component)
    current = instance
    cursor = 0
    instance.pending = []
    const tree = component({ ...props })
    for (const cell of instance.cells) {
      if (cell.kind !== 'effect' || cell.rerun !== true) continue
      cell.rerun = false
      if (typeof cell.cleanup === 'function') cell.cleanup()
      cell.cleanup = undefined
    }
    for (const cell of instance.pending) {
      const result = cell.effect()
      cell.cleanup = typeof result === 'function' ? result : undefined
    }
    current = undefined
    return tree
  }

  /**
   * Run one component's effect cleanups and drop its hook state.
   * @param component - component function.
   */
  function unmount(component) {
    const instance = instances.get(component)
    if (instance === undefined) return
    for (const cell of instance.cells) {
      if (cell.kind === 'effect' && typeof cell.cleanup === 'function') cell.cleanup()
    }
    instances.delete(component)
  }

  /** Unmount every component this runtime rendered. */
  function reset() {
    for (const component of [...instances.keys()]) unmount(component)
  }

  return { React, render, unmount, reset }
}
