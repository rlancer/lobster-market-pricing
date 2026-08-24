/**
 * Guard against Vite 8 / lightningcss dropping unprefixed `backdrop-filter`
 * (keeps only `-webkit-backdrop-filter`, which Chromium ignores → no blur).
 * See vite#22649 / lightningcss#785.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const distAssets = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets')
const cssFile = readdirSync(distAssets).find((name) => name.endsWith('.css'))
if (!cssFile) {
  console.error('assert-backdrop-filter: no CSS asset in dist/assets')
  process.exit(1)
}

const css = readFileSync(join(distAssets, cssFile), 'utf8')
const navRuleMatch = css.match(/\.mobile-bottom-nav\{[^}]+\}/g)
if (!navRuleMatch) {
  console.error('assert-backdrop-filter: .mobile-bottom-nav rule missing')
  process.exit(1)
}

const mobileRule = navRuleMatch.find((rule) => rule.includes('position:fixed')) ?? navRuleMatch.at(-1)
if (!mobileRule) {
  console.error('assert-backdrop-filter: fixed .mobile-bottom-nav rule missing')
  process.exit(1)
}

const hasUnprefixed = /(?<!-webkit-)backdrop-filter\s*:\s*[^;]*blur\(/.test(mobileRule)
if (!hasUnprefixed) {
  console.error(
    'assert-backdrop-filter: .mobile-bottom-nav lost unprefixed backdrop-filter:\n',
    mobileRule,
  )
  process.exit(1)
}

console.log('assert-backdrop-filter: ok —', cssFile)
