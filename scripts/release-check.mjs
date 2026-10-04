#!/usr/bin/env node
/**
 * 发布前不变量检查（`npm run release:check`）——移植自 dsh-agent-shell 的做法，按本插件裁剪。
 *
 * 把「发版时必须成立、但很容易忘」的事情变成机械检查：
 *   1. package.json 版本是合法 semver、且不是 private；docs/CHANGELOG.md 有对应段落；
 *   2. npm `files` 白名单**恰好等于**「必要文件」集合（少发 → 装完起不来；多发 → 把仓库内部文件搬上注册表）；
 *   3. main / exports 指向的文件存在且在白名单内（发布出去的包必须能 import）；
 *   4. peerDependencies 覆盖代码里真正 import 的宿主包；
 *   5. lib/client.js 保持 classic script（一旦误加 import/export，浏览器端整体崩掉）；
 *   6. 工作树里没有泄漏开发机绝对路径 / 主机名 / 私钥 / token（规则见 lib/leak-rules.mjs）；
 *   7. cordis.patch.yml 仍在插入插件行；
 *   8. README.md 的相对链接只指向发布物内文件（相对链接在 npm 页面上必然断）。
 *
 * 只依赖 Node 标准库；退出码非 0 表示有阻塞项。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'
import { findLeaks, SKIP_DIRS, BINARY_FILE } from './lib/leak-rules.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

const fail = (message) => failures.push(message)
const note = (message) => notes.push(message)

function readText(rel) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) { fail(`缺少文件：${rel}`); return undefined }
  return readFileSync(abs, 'utf8')
}
function readJson(rel) {
  const text = readText(rel)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch (error) { fail(`${rel} 不是合法 JSON：${error.message}`); return undefined }
}

/* ── 0. 必要文件集合（发布物）──────────────────────────────────────────── */
const RELEASE_FILES = new Set([
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/core.js',
  'lib/config.js',
  'lib/callbacks.js',
  'lib/approval.js',
  'lib/pre.js',
  'lib/restore.js',
  'cordis.patch.yml',
  'README.md',
  'SECURITY.md',
  'NOTICE',
  'LICENSE',
])

/** 把 npm files 条目展开为真实文件集合（目录递归）。 */
function expandFiles(entries) {
  const out = new Set()
  for (const entry of entries) {
    const abs = join(ROOT, entry)
    if (!existsSync(abs)) { fail(`files 白名单里的条目不存在：${entry}`); continue }
    if (statSync(abs).isDirectory()) {
      for (const child of readdirSync(abs)) out.add(`${entry}/${child}`)
    } else out.add(entry)
  }
  return out
}

/* ── 1. 版本与 CHANGELOG ──────────────────────────────────────────────── */
const pkg = readJson('package.json')
if (pkg !== undefined) {
  const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
  if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) {
    fail(`package.json version 不是合法 semver：${JSON.stringify(pkg.version)}`)
  }
  if (pkg.private === true) fail('package.json 里 private: true 会让 npm publish 直接失败')

  const changelog = readText('docs/CHANGELOG.md')
  if (changelog !== undefined && !new RegExp(`^## \\[?${pkg.version.replace(/\./g, '\\.')}\\]?`, 'm').test(changelog)) {
    fail(`docs/CHANGELOG.md 里没有「## ${pkg.version}」段落（发版必须记录改了什么）`)
  }

  /* ── 2. files 白名单恰好等于必要文件集合 ─────────────────────────── */
  const declared = expandFiles(Array.isArray(pkg.files) ? pkg.files : [])
  // npm 强制包含这几项（即使不写进 files），检查时并入集合
  for (const auto of ['package.json', 'README.md', 'LICENSE']) {
    if (existsSync(join(ROOT, auto))) declared.add(auto)
  }
  for (const file of declared) if (!RELEASE_FILES.has(file)) fail(`files 白名单多带了非发布文件：${file}`)
  for (const file of RELEASE_FILES) if (!declared.has(file)) fail(`files 白名单缺少必要文件：${file}`)

  /* ── 3. main / exports 指向存在的白名单文件 ─────────────────────── */
  const entryFiles = new Set()
  if (typeof pkg.main === 'string') entryFiles.add(pkg.main.replace(/^\.\//, ''))
  for (const value of Object.values(pkg.exports || {})) {
    const target = typeof value === 'string' ? value : (value && value.default)
    if (typeof target === 'string' && target.startsWith('./')) entryFiles.add(target.replace(/^\.\//, ''))
  }
  for (const file of entryFiles) {
    if (!existsSync(join(ROOT, file))) fail(`main/exports 指向的文件不存在：${file}`)
    else if (!RELEASE_FILES.has(file)) fail(`main/exports 指向的文件不在发布物里：${file}`)
  }

  /* ── 4. peerDependencies 覆盖真正 import 的宿主包 ───────────────── */
  for (const dep of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery', 'react']) {
    if (!(pkg.peerDependencies && dep in pkg.peerDependencies)) fail(`peerDependencies 缺少 ${dep}（代码会 import 它）`)
  }
  if (pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform !== 'web') fail('dsh.client.platform 必须是 "web"')
}

/* ── 5. client 半保持 classic script ─────────────────────────────────── */
const client = readText('lib/client.js')
if (client !== undefined) {
  if (/^\s*import\s/m.test(client) || /^\s*export\s/m.test(client)) {
    fail('lib/client.js 必须保持 classic script（不能出现 import/export —— 浏览器端会整体崩）')
  }
  if (!client.includes('window.__ModuleLoader__.load(')) fail('lib/client.js 缺少 __ModuleLoader__.load 注册（client 半不会生效）')
}

/* ── 6. 泄露扫描（整棵工作树）────────────────────────────────────────── */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    const stat = statSync(abs)
    if (stat.isDirectory()) out.push(...walk(abs))
    else out.push(abs)
  }
  return out
}
for (const abs of walk(ROOT)) {
  const rel = relative(ROOT, abs)
  if (BINARY_FILE.test(rel)) continue
  if (rel === 'scripts/lib/leak-rules.mjs' || rel === 'scripts/release-check.mjs') continue // 规则自身含模式串
  const text = readFileSync(abs, 'utf8')
  for (const hit of findLeaks(text)) fail(`${rel}:${hit.line} 疑似泄露（${hit.what}）：${hit.text}`)
}

/* ── 7. bundle patch 仍在插入插件行 ──────────────────────────────────── */
const patch = readText('cordis.patch.yml')
if (patch !== undefined) {
  if (!patch.includes('id: harness-restart')) fail('cordis.patch.yml 里找不到 "id: harness-restart" 插入行')
  if (!patch.includes('name: \'dsh-harness-restart\'')) fail('cordis.patch.yml 的插件行 name 不对')
}

/* ── 8. README.md 相对链接只指向发布物 ──────────────────────────────── */
const readme = readText('README.md')
if (readme !== undefined) {
  const links = [...readme.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)].map((m) => m[1])
  for (const link of links) {
    const clean = link.replace(/^\.\//, '').split('#')[0]
    if (clean === '') continue
    if (!RELEASE_FILES.has(clean)) fail(`README.md 里的相对链接指向非发布物文件：${link}`)
  }
}

/* ── 总结 ────────────────────────────────────────────────────────────── */
for (const message of notes) console.log(`· ${message}`)
if (failures.length > 0) {
  console.error(`\n✗ release:check 失败（${failures.length} 项）：`)
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}
console.log('✓ release:check 通过（版本 / CHANGELOG / files 白名单 / 入口 / peer / classic client / 泄露 / patch / README 链接）')