import assert from 'node:assert/strict'
import { test } from 'node:test'

import { environmentName, resolveEnvironment } from '../src/backoffice/lib/environment.ts'

const cases: Array<{
  name: string
  appEnv: string | null
  label: string | null
  kind: 'sandbox' | 'production' | 'neutral'
  en: string
  zh: string
}> = [
  { name: 'SANDBOX', appEnv: 'SANDBOX', label: 'Sandbox', kind: 'sandbox', en: 'Sandbox', zh: '沙盒' },
  { name: 'lower case', appEnv: 'sandbox', label: null, kind: 'sandbox', en: 'Sandbox', zh: '沙盒' },
  { name: 'PROD', appEnv: 'PROD', label: 'Production', kind: 'production', en: 'Production', zh: '生产' },
  { name: 'DEV with derived label', appEnv: 'DEV', label: 'Sandbox', kind: 'neutral', en: 'DEV', zh: 'DEV' },
  { name: 'UAT with derived label', appEnv: 'UAT', label: 'Production', kind: 'neutral', en: 'UAT', zh: 'UAT' },
  { name: 'SIT with custom label', appEnv: 'SIT', label: 'Training', kind: 'neutral', en: 'Training', zh: 'Training' },
  { name: 'health unreadable', appEnv: null, label: 'Sandbox', kind: 'neutral', en: 'Unknown environment', zh: '未知环境' },
  { name: 'nothing known', appEnv: null, label: null, kind: 'neutral', en: 'Unknown environment', zh: '未知环境' },
]

for (const item of cases) {
  test(`environment identity: ${item.name}`, () => {
    const identity = resolveEnvironment(item.appEnv, item.label)
    assert.equal(identity.kind, item.kind)
    assert.equal(environmentName('en-GB', identity), item.en)
    assert.equal(environmentName('zh-CN', identity), item.zh)
  })
}

test('environment identity: not answered yet is pending and unnamed, failed read is Unknown', () => {
  const waiting = resolveEnvironment(undefined, null)
  assert.equal(waiting.kind, 'neutral')
  assert.equal(waiting.pending, true)
  assert.equal(environmentName('en-GB', waiting), '')
  const failed = resolveEnvironment(null, null)
  assert.equal(failed.pending, undefined)
  assert.equal(environmentName('en-GB', failed), 'Unknown environment')
})

test('environment identity: blank code becomes null', () => {
  assert.equal(resolveEnvironment('  ', null).code, null)
  assert.equal(resolveEnvironment(' uat ', null).code, 'UAT')
})
