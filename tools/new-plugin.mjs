#!/usr/bin/env node
// Turns a copy of homebridge-plugin-template into a new plugin, once, in a fresh repository:
//
//   node tools/new-plugin.mjs homebridge-my-device MyDevicePlatform "My Device"
//
// The template is homebridge/homebridge-plugin-template with a stricter setup on top (see the README).
//
// Renames the npm package (and the GitHub links, the repository having the same name), the
// platform (config.schema.json's pluginAlias, what users write as "platform" in config.json) and
// the display name in every tracked file; sets the version to 0.1.0 with a fresh changelog;
// removes the README's "Using this template" section; then deletes this script. The shared
// files (.github/ apart from the issue forms, .oxlintrc.json) don't name the template and are
// left alone, so they stay the same as in the other plugins. Commit the result, after `npm install` and `npm run verify`.
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, rmdirSync, readdirSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import console from 'node:console'

const [name, platform, displayName] = process.argv.slice(2)
const fail = (msg) => {
  console.error(`new-plugin: ${msg}`)
  process.exit(1)
}
if (!name || !platform || !displayName) {
  fail('usage: node tools/new-plugin.mjs <npm name, homebridge-…> <PlatformName> "<Display Name>"')
}
if (!/^homebridge-[a-z0-9][a-z0-9-]*$/.test(name)) fail(`"${name}": the npm name must be homebridge- followed by lowercase letters, digits and hyphens`)
if (!/^[A-Za-z][A-Za-z0-9]*$/.test(platform)) fail(`"${platform}": the platform name must be letters and digits, starting with a letter`)
if (/["\\]/.test(displayName) || !displayName.trim()) fail('the display name must not be empty or contain " or \\')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.name !== 'homebridge-plugin-template') fail('this checkout is no longer the template (package.json was renamed already)')

const self = 'tools/new-plugin.mjs'
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  // The shared files stay as they are; the issue forms (.github/ISSUE_TEMPLATE) are this plugin's own.
  .filter((f) => f && f !== self && f !== 'package-lock.json' && f !== '.oxlintrc.json' && !(f.startsWith('.github/') && !f.startsWith('.github/ISSUE_TEMPLATE/')))
// The template's own name, but not the official template it is built on
// (homebridge/homebridge-plugin-template), which the README and comments name.
const replacements = [
  [/(?<!homebridge\/)homebridge-plugin-template/g, name],
  [/ExampleHomebridgePlugin/g, platform],
  [/Plugin Template/g, displayName],
]
for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  let out = text
  for (const [from, to] of replacements) out = out.replace(from, to)
  if (out !== text) {
    writeFileSync(file, out)
    console.log(`updated ${file}`)
  }
}

// A fresh version, description and changelog.
const updated = JSON.parse(readFileSync('package.json', 'utf8'))
updated.version = '0.1.0'
updated.description = `Homebridge plugin for ${displayName}.`
writeFileSync('package.json', `${JSON.stringify(updated, null, 2)}\n`)
writeFileSync('CHANGELOG.md', '# Changelog\n\n## 0.1.0 - unreleased\n\n- First version.\n')

// The README's instructions for using the template.
const readme = readFileSync('README.md', 'utf8')
const start = readme.indexOf('## Using this template')
const end = readme.indexOf('\n## ', start + 1)
if (start >= 0 && end > start) writeFileSync('README.md', readme.slice(0, start) + readme.slice(end + 1))

// package-lock.json names the package too; its dependency versions stay as they are.
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
lock.name = name
lock.version = '0.1.0'
if (lock.packages?.['']) Object.assign(lock.packages[''], { name, version: '0.1.0' })
writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`)
// The weekly sync with the official template is for the template only.
rmSync('.github/workflows/upstream-sync.yml', { force: true })
rmSync(self)
if (readdirSync('tools').length === 0) rmdirSync('tools')
// Staged, so that the checks (which list the files with git) don't look for the removed ones.
execFileSync('git', ['add', '-A'])
console.log(`\n${name} is ready: run npm install, npm run verify, then commit.`)
