#!/usr/bin/env node
/**
 * Verify the documentation the repository promises.
 *
 * Both READMEs are also rendered by npm from the published tarball, where
 * relative links are rewritten against the `repository` field and relative
 * images resolve to raw GitHub URLs. So every relative target a README points at
 * has to exist in the tree, the two languages have to keep linking each other,
 * and a badge has to stay absolute — a deleted screenshot left behind in a
 * README is exactly the drift this catches.
 *
 * Usage: `node tools/verify-docs.mjs`
 * @module tools/verify-docs
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

/** @param condition - value that must be truthy. @param message - failure description. */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const readmes = ['README.md', 'README_EN.md']
const sources = new Map()
for (const name of readmes) sources.set(name, await readFile(path.join(root, name), 'utf8'))
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

// Markdown links and images: `[text](target)` and `![alt](target)`.
const TARGET = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu

for (const [name, text] of sources) {
  check(`${name}: every relative link and image exists`, () => {
    for (const match of text.matchAll(TARGET)) {
      const target = match[1]
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('#')) continue
      const file = target.split('#')[0]
      if (file === '') continue
      assert(existsSync(path.join(root, file)), `${name} points at a missing file: ${target}`)
    }
  })
  check(`${name}: badge images and their targets are absolute`, () => {
    // A badge is an image wrapped in a link: npm renders README images from the
    // repository but does not rewrite link targets, so both sides must be URLs.
    const badges = [...text.matchAll(/\[!\[[^\]]*\]\(([^)\s]+)\)\]\(([^)\s]+)\)/gu)]
    assert(badges.length > 0, `${name} carries no badge`)
    for (const [, image, target] of badges) {
      assert(/^https?:/u.test(image), `${name} has a relative badge image: ${image}`)
      // An in-page anchor is fine: only a relative *path* would break on npm.
      assert(/^https?:/u.test(target) || target.startsWith('#'), `${name} has a relative badge target: ${target}`)
    }
  })
  check(`${name}: the name and version match package.json`, () => {
    assert(text.includes(packageJson.name), `${name} never names ${packageJson.name}`)
  })
}

check('the two READMEs link each other', () => {
  assert(sources.get('README.md').includes('](README_EN.md)'), 'README.md does not link the English one')
  assert(sources.get('README_EN.md').includes('](README.md)'), 'README_EN.md does not link the Chinese one')
})
check('every asset under docs/ is referenced by a README', () => {
  const referenced = new Set()
  for (const text of sources.values()) {
    for (const match of text.matchAll(/!\[[^\]]*\]\((docs\/[^)\s]+)/gu)) referenced.add(match[1])
  }
  const shipped = (existsSync(path.join(root, 'docs')) ? readdirSync(path.join(root, 'docs')) : [])
    .map(entry => `docs/${entry}`)
  const orphaned = shipped.filter(asset => !referenced.has(asset))
  assert(orphaned.length === 0, `shipped under docs/ but unreferenced: ${orphaned.join(', ')}`)
})
check('the package ships every file a README needs to render', () => {
  assert(packageJson.files.includes('README.md') && packageJson.files.includes('README_EN.md'), 'the tarball drops a README')
})

for (const row of checks) console.log(`${row.ok ? '✔' : '✘'} ${row.name}${row.ok ? '' : ` — ${row.error}`}`)
const failed = checks.filter(row => !row.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
