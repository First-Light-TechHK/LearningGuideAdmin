// 语言守卫：把“界面只显示当前语言”从靠人记住变成编译期规则。
// 浏览器里的同一条规则见 e2e/i18n-language.e2e.test.mjs。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { SERVER_MESSAGES, SERVER_MESSAGE_PATTERNS, serverText } from '../src/backoffice/lib/i18n/serverText.ts'

const client = fileURLToPath(new URL('..', import.meta.url))
const src = join(client, 'src')
const server = join(client, '..', 'server', 'src')
const HAN = /\p{Script=Han}/u

// 中文界面允许的英文：产品固定用词（AGENTS.md）、技术名词和文件格式。其它英文词要翻译。
const ZH_ALLOWED_TERMS = new Set(['Learning', 'Guide', 'BackOffice', 'Portal', 'PORTAL', 'AI', 'Tutor', 'HelpDesk', 'HELPDESK', 'Help', 'Desk', 'Improve', 'FAQ', 'LLM', 'Stripe', 'Google', 'Docs', 'Wikimedia', 'Commons', 'Word', 'Excel', 'Markdown', 'OpenRouter', 'Lookup', 'key', 'Key', 'Token', 'Trace', 'ID', 'API', 'URL', 'url', 'http', 'https', 'mailto', 'example', 'com', 'name', 'password', 'ZIP', 'zip', 'lgcourse', 'xlsx', 'csv', 'docx', 'JPG', 'PNG', 'MP', 'MOV', 'WebM', 'MB', 'KB', 'px', 'mm', 'ss', 'USD', 'UTC', 'PC', 'PRD', 'Ctrl', 'Enter', 'Mac', 'English', 'EN', 'recall', 'BASE', 'TOKEN', 'Sync'])

function latinWords(text: string): string[] {
  return (text.replace(/\{[^}]*\}/g, ' ').replace(/`[^`]*`/g, ' ').match(/[A-Za-z]{2,}/g) ?? [])
}

function files(dir: string, keep: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path, keep)
    return keep.test(name) && !/\.(test|spec)\./.test(name) ? [path] : []
  })
}

function flat(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]]
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => flat(item, prefix ? `${prefix}.${key}` : key))
  return []
}

const en = flat(JSON.parse(readFileSync(join(src, 'backoffice/messages/en-GB.json'), 'utf8')))
const zh = flat(JSON.parse(readFileSync(join(src, 'backoffice/messages/zh-CN.json'), 'utf8')))

test('两份语言包的 key 完全一致', () => {
  const enKeys = en.map(([key]) => key).sort()
  const zhKeys = zh.map(([key]) => key).sort()
  assert.deepEqual(enKeys, zhKeys)
})

test('英文语言包没有中文（语言切换标签和中英文对照编辑器除外）', () => {
  const allowed = new Set(['helpDesk.preview.zh', 'helpDesk.candidates.draftSources', 'helpDesk.review.editor.zh', 'shell.switchLanguage'])
  assert.deepEqual(en.filter(([key, value]) => HAN.test(value) && !allowed.has(key)).map(([key]) => key), [])
})

test('中文语言包没有未翻译的英文词', () => {
  const allowedKeys = new Set(['shell.switchLanguage', 'helpDesk.trace.fields.traceId'])
  const bad = zh.filter(([key, value]) => !allowedKeys.has(key) && latinWords(value).some((word) => !ZH_ALLOWED_TERMS.has(word)))
  assert.deepEqual(bad, [])
})

function parse(path: string) {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

const sources = files(src, /\.tsx?$/)

test('L(zh, en) 两边语言不串：中文一侧是中文、没有未翻译的词，英文一侧没有中文', () => {
  const bad: string[] = []
  for (const path of sources) {
    const file = parse(path)
    walk(file, (node) => {
      if (!ts.isCallExpression(node) || node.expression.getText() !== 'L') return
      const args = node.arguments
      const offset = args.length === 3 ? 1 : 0
      const [zhArg, enArg] = [args[offset], args[offset + 1]]
      if (!zhArg || !enArg) return
      const at = `${path.slice(src.length + 1)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
      if (ts.isStringLiteralLike(zhArg)) {
        const words = latinWords(zhArg.text).filter((word) => !ZH_ALLOWED_TERMS.has(word))
        if (words.length) bad.push(`${at} 中文一侧有未翻译的词 ${words.join(',')}: ${zhArg.text}`)
      }
      if (ts.isStringLiteralLike(enArg) && HAN.test(enArg.text)) bad.push(`${at} 英文一侧有中文: ${enArg.text}`)
    })
  }
  assert.deepEqual(bad, [])
})

test('界面文字不能写死中文：要走 t() 或 L()', () => {
  const allowed = /^(backoffice\/lib\/i18n\/|backoffice\/lib\/categoryLabel\.ts|backoffice\/components\/LocaleSwitch\.tsx|backoffice\/lib\/helpdeskGraph\.ts|backoffice\/lib\/helpdeskChanges\.ts)/
  const bad: string[] = []
  for (const path of sources) {
    const rel = path.slice(src.length + 1)
    if (allowed.test(rel)) continue
    const file = parse(path)
    walk(file, (node) => {
      const isText = ts.isJsxText(node) || ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      if (!isText || !HAN.test(node.getText())) return
      for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
        if (!ts.isCallExpression(up)) continue
        const callee = up.expression.getText()
        // L() 成对的文案，以及 zh ? '中文' : 'English' 这种成对写法由下一条规则查。
        if (callee === 'L' || callee.startsWith('console.')) return
      }
      for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
        if ((ts.isConditionalExpression(up) || ts.isIfStatement(up)) && /\b(zh|isZh)\b|startsWith\('zh'\)|=== 'zh-CN'/.test((ts.isIfStatement(up) ? up.expression : up.condition).getText())) return
        // 把后端英文句子译成中文的对照表，只在中文界面用。
        if (ts.isFunctionDeclaration(up) && up.name?.text === 'localizeMissing') return
      }
      if (ts.isPropertyAssignment(node.parent) && /^(zh|'zh-CN'|"zh-CN"|zh_CN)$/.test(node.parent.name.getText())) return
      bad.push(`${rel}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.getText().trim().slice(0, 50)}`)
    })
  }
  assert.deepEqual(bad, [])
})

test('日期不能跟浏览器语言：toLocale*String() 必须传语言', () => {
  const bad: string[] = []
  for (const path of sources) {
    const file = parse(path)
    walk(file, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
      if (!/^toLocale(Date|Time)?String$/.test(node.expression.name.text)) return
      const first = node.arguments[0]
      if (!first || first.getText() === 'undefined') bad.push(`${path.slice(src.length + 1)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
    })
  }
  assert.deepEqual(bad, [])
})

test('读后端错误句子的请求层都要经过 serverText', () => {
  const bad = sources
    .filter((path) => /\b(body|json|j|envelope)\??\.error\??\.message/.test(readFileSync(path, 'utf8')))
    .filter((path) => !readFileSync(path, 'utf8').includes('serverText('))
    .map((path) => path.slice(src.length + 1))
  assert.deepEqual(bad, [])
})

test('后端每一句中文报错都有英文译文（新增报错忘了翻译会失败）', () => {
  const known = new Set(SERVER_MESSAGES.map(([zhText]) => zhText))
  const covered = (text: string) => known.has(text) || SERVER_MESSAGE_PATTERNS.some(([pattern]) => pattern.test(text))
  const bad: string[] = []
  // Helpdesk 走错误码（helpDesk.errors），上线门禁里的中文句子不进界面。
  const skip = /backoffice[\\/]modules[\\/]helpdesk|ai[\\/]helpdesk|[\\/]eval[\\/]|prisma[\\/]/
  for (const path of files(server, /\.ts$/)) {
    if (skip.test(path)) continue
    const file = parse(path)
    walk(file, (node) => {
      if (!ts.isNewExpression(node) && !ts.isPropertyAssignment(node)) return
      const isError = ts.isNewExpression(node) && /(Exception|UnavailableError)$/.test(node.expression.getText())
      const isMessage = ts.isPropertyAssignment(node) && node.name.getText() === 'message'
      if (!isError && !isMessage) return
      const value = ts.isNewExpression(node) ? node.arguments?.[0] : node.initializer
      if (!value) return
      let text: string | null = null
      if (ts.isStringLiteralLike(value)) text = value.text
      else if (ts.isTemplateExpression(value)) text = value.getText().slice(1, -1).replace(/\$\{[^}]*\}/g, 'x')
      if (text && HAN.test(text) && !covered(text)) bad.push(`${path.slice(server.length + 1)}: ${text}`)
    })
  }
  assert.deepEqual(bad, [])
})

test('serverText：页面语言决定显示什么', () => {
  assert.equal(serverText('课程不存在', 'en-GB'), 'The course does not exist.')
  assert.equal(serverText('课程不存在', 'zh-CN'), '课程不存在')
  assert.equal(serverText('不支持的 LLM 模型：gpt-x', 'en-GB'), 'Unsupported LLM model: gpt-x')
  assert.equal(serverText('The course does not exist.', 'zh-CN'), '课程不存在')
  assert.equal(serverText('Plain English problem', 'en-GB'), 'Plain English problem')
  assert.equal(serverText('Plain English problem', 'zh-CN'), '操作失败，请重试。')
  assert.equal(serverText('从没见过的中文报错啊', 'en-GB'), 'Something went wrong. Please try again.')
  assert.equal(serverText(null, 'en-GB'), 'Something went wrong. Please try again.')
})
