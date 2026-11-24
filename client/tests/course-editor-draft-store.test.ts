// 草稿存储工具的纯逻辑单测：key 规范、严格读取、损坏数据、配额降级、清理与 TTL。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  clearEditorDrafts,
  draftKey,
  readDraft,
  removeDraft,
  setDraftStorageForTests,
  sweepEditorDrafts,
  writeDraft,
} from '../src/backoffice/lib/editorDraftStore'

class MemoryStorage implements Storage {
  map = new Map<string, string>()
  throwAlways = false
  limit = Number.POSITIVE_INFINITY
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  setItem(key: string, value: string) {
    if (this.throwAlways) throw new Error('QuotaExceededError')
    if (!this.map.has(key) && this.map.size >= this.limit) throw new Error('QuotaExceededError')
    this.map.set(key, value)
  }
}

type N = { n: number }
const parseN = (raw: unknown): N | null => {
  const value = raw as { n?: unknown } | null
  return value && typeof value.n === 'number' ? { n: value.n } : null
}

const study = { courseId: 'c-1', step: 'study' as const, lessonId: 'l-1', language: 'en-GB' }

test('key 规范：版本号 + 课程 + 步骤 + 课时 + 语言；info 退化为课程级', () => {
  assert.equal(draftKey(study), 'lg.bo.course-editor.draft.v1:c-1:study:l-1:en-GB')
  assert.equal(draftKey({ courseId: 'c-1', step: 'understanding', lessonId: 'l-1', language: 'zh-CN' }), 'lg.bo.course-editor.draft.v1:c-1:understanding:l-1:zh-CN')
  assert.equal(draftKey({ courseId: 'c-1', step: 'info' }), 'lg.bo.course-editor.draft.v1:c-1:info')
})

test('写入后原样读回；身份不符 / 损坏 JSON / 版本不符 / 字段形状不符都按无草稿处理', () => {
  const storage = new MemoryStorage()
  setDraftStorageForTests(storage)
  assert.equal(writeDraft(study, { base: { n: 1 }, draft: { n: 2 } }, 1000), true)
  const stored = readDraft(study, parseN)
  assert.ok(stored)
  assert.deepEqual(stored.draft, { n: 2 })
  assert.deepEqual(stored.base, { n: 1 })
  assert.equal(stored.updatedAt, 1000)
  assert.equal(stored.v, 1)

  const raw = storage.getItem(draftKey(study))!
  // 身份与 key 不符：篡改 payload 里的 lessonId。
  storage.setItem(draftKey(study), raw.replace('"lessonId":"l-1"', '"lessonId":"l-2"'))
  assert.equal(readDraft(study, parseN), null)

  storage.setItem(draftKey(study), '{not json')
  assert.equal(readDraft(study, parseN), null)

  storage.setItem(draftKey(study), JSON.stringify({ v: 2, identity: study, updatedAt: 1, base: { n: 1 }, draft: { n: 2 } }))
  assert.equal(readDraft(study, parseN), null)

  storage.setItem(draftKey(study), JSON.stringify({ v: 1, identity: study, updatedAt: 1, base: { n: 'x' }, draft: { n: 2 } }))
  assert.equal(readDraft(study, parseN), null)

  removeDraft(study)
  assert.equal(readDraft(study, parseN), null)
})

test('存储不可用 / 写入抛错时静默降级：返回 false，不抛', () => {
  setDraftStorageForTests(null)
  assert.equal(writeDraft(study, { base: { n: 1 }, draft: { n: 2 } }), false)
  assert.equal(readDraft(study, parseN), null)
  removeDraft(study)

  const storage = new MemoryStorage()
  storage.throwAlways = true
  setDraftStorageForTests(storage)
  assert.equal(writeDraft(study, { base: { n: 1 }, draft: { n: 2 } }), false)
})

test('配额满：淘汰最旧的一条后重试成功', () => {
  const storage = new MemoryStorage()
  storage.limit = 2
  setDraftStorageForTests(storage)
  assert.equal(writeDraft(study, { base: { n: 1 }, draft: { n: 1 } }, 1000), true)
  assert.equal(writeDraft({ ...study, language: 'zh-CN' }, { base: { n: 1 }, draft: { n: 1 } }, 2000), true)
  assert.equal(storage.length, 2)
  assert.equal(writeDraft({ ...study, lessonId: 'l-2' }, { base: { n: 1 }, draft: { n: 1 } }, 3000), true)
  assert.equal(storage.length, 2, 'evicting one entry should make room for the new one')
  assert.equal(storage.getItem(draftKey(study)), null, 'the oldest entry should be gone')
  assert.ok(storage.getItem(draftKey({ ...study, lessonId: 'l-2' })))
})

test('单条超过 1 MB 的草稿放弃暂存（页面编辑不受影响）', () => {
  const storage = new MemoryStorage()
  setDraftStorageForTests(storage)
  assert.equal(writeDraft(study, { base: { n: 0 }, draft: { n: 1, huge: 'x'.repeat(1_100_000) } as unknown as N }), false)
  assert.equal(storage.length, 0)
})

test('clearEditorDrafts 只清草稿前缀，不动其它 key', () => {
  const session = new MemoryStorage()
  const local = new MemoryStorage()
  session.setItem(draftKey(study), '{}')
  session.setItem('lg.bo.course-editor.draft.v2:old', '{}')
  session.setItem('other.key', 'keep')
  local.setItem(draftKey({ courseId: 'c-9', step: 'info' }), '{}')
  local.setItem('aitutor.chat.1', 'keep')
  clearEditorDrafts([session, local])
  assert.equal(session.length, 1)
  assert.equal(session.getItem('other.key'), 'keep')
  assert.equal(local.length, 1)
  assert.equal(local.getItem('aitutor.chat.1'), 'keep')
})

test('sweepEditorDrafts：删 7 天前的、损坏的、版本不符的；超过 50 条按最旧删除', () => {
  const storage = new MemoryStorage()
  setDraftStorageForTests(storage)
  const now = 10_000_000_000
  const fresh = { courseId: 'c-1', step: 'study' as const, lessonId: 'fresh', language: 'en-GB' }
  const stale = { courseId: 'c-1', step: 'study' as const, lessonId: 'stale', language: 'en-GB' }
  writeDraft(fresh, { base: { n: 1 }, draft: { n: 2 } }, now)
  writeDraft(stale, { base: { n: 1 }, draft: { n: 2 } }, now - 8 * 24 * 60 * 60 * 1000)
  storage.setItem(`${draftKey(fresh)}x`, 'broken') // 前缀相同但 key 不在规范内
  storage.setItem('lg.bo.course-editor.draft.v1:c-1:study:bad:en-GB', '{broken json')
  sweepEditorDrafts(now)
  assert.ok(storage.getItem(draftKey(fresh)))
  assert.equal(storage.getItem(draftKey(stale)), null)
  assert.equal(storage.getItem('lg.bo.course-editor.draft.v1:c-1:study:bad:en-GB'), null)

  const storage2 = new MemoryStorage()
  setDraftStorageForTests(storage2)
  for (let index = 0; index < 51; index += 1) {
    writeDraft({ courseId: 'c-2', step: 'study', lessonId: `l-${index}`, language: 'en-GB' }, { base: { n: 1 }, draft: { n: 2 } }, now + index)
  }
  sweepEditorDrafts(now + 1000)
  assert.equal(storage2.length, 50)
  assert.equal(storage2.getItem(draftKey({ courseId: 'c-2', step: 'study', lessonId: 'l-0', language: 'en-GB' })), null, 'the oldest should be evicted')
  assert.ok(storage2.getItem(draftKey({ courseId: 'c-2', step: 'study', lessonId: 'l-50', language: 'en-GB' })))
})
