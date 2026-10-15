/**
 * Resolve Harness packages from the dsh installation the tools run against.
 *
 * The scripts in `tools/` must not hard-code a checkout path: they find the dsh
 * installation through `$DSH_MODULES_DIR`, the `dsh` binary on `PATH`, or
 * `$DSH_PROFILE_DIR`, then resolve workspace-free specifiers the same way Node
 * would from there.
 *
 * @module tools/lib/dsh-modules
 */

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Directories to resolve from, most explicit first.
 * @returns candidate anchor directories.
 */
function anchors() {
  const list = []
  if (process.env.DSH_MODULES_DIR !== undefined && process.env.DSH_MODULES_DIR !== '') {
    list.push(process.env.DSH_MODULES_DIR)
  }
  try {
    const bin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (bin !== '') list.push(dirname(realpathSync(bin)))
  } catch {
    // No dsh on PATH: an explicit DSH_MODULES_DIR or DSH_PROFILE_DIR may still answer.
  }
  if (process.env.DSH_PROFILE_DIR !== undefined && process.env.DSH_PROFILE_DIR !== '') {
    list.push(process.env.DSH_PROFILE_DIR)
  }
  return list
}

/**
 * Resolve one Harness package specifier against a directory that has it.
 * @param spec - package specifier, including a subpath such as `@deepseek-ai/dsh-session/fork`.
 * @returns the resolved file path.
 * @throws when no candidate anchor resolves it.
 */
export function resolveDsh(spec) {
  const tried = anchors()
  for (const anchor of tried) {
    try {
      return createRequire(join(anchor, 'anchor.js')).resolve(spec)
    } catch {
      // Next anchor.
    }
  }
  throw new Error(
    `cannot resolve ${JSON.stringify(spec)}: set DSH_MODULES_DIR to a directory whose node_modules holds the dsh packages`
    + ` (tried: ${tried.length === 0 ? 'nothing; is dsh on PATH?' : tried.join(', ')})`,
  )
}

/**
 * Import one Harness package module.
 * @param spec - package specifier.
 * @returns the module namespace.
 */
export async function importDsh(spec) {
  return import(pathToFileURL(resolveDsh(spec)).href)
}

/**
 * Import this plugin's Host half.
 * @returns the module namespace.
 */
export async function importPluginHost() {
  return import(new URL('../../index.js', import.meta.url).href)
}

/**
 * Import this plugin's Browser half, which registers itself into
 * `window.__ModuleLoader__` and needs a `react` stub in place first.
 * @returns the plugin object the factory returned.
 */
export async function importPluginClient() {
  let api
  globalThis.__reviseChanReactStub = reactStub
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        api = factory(name => {
          if (name === 'react') return reactStub
          throw new Error(`unexpected require(${JSON.stringify(name)})`)
        })
      },
    },
  }
  await import(new URL('../../client.js', import.meta.url).href)
  if (api === undefined) throw new Error('client.js did not call window.__ModuleLoader__.load')
  return api
}

/** Minimal `react` stand-in: element trees and inert hooks, no renderer. */
export const reactStub = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: fn => fn,
  useEffect: () => {},
  useMemo: fn => fn(),
  useRef: value => ({ current: value }),
  memo: component => component,
}
