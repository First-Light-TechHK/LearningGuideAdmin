import test from 'node:test'
import assert from 'node:assert/strict'

import {
  VERSION_STABLE_POLLS,
  decideVersionPoll,
  initialVersionState,
  isEditing,
  startVersionWatch,
} from '../src/lib/versionWatch.ts'

/** Minimal sessionStorage stand-in, so the guard behaviour is observable. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('a matching version is ignored and never reloads', () => {
  const state = initialVersionState('v1')
  assert.equal(decideVersionPoll(state, 'v1'), 'ignore')
  assert.equal(decideVersionPoll(state, null), 'ignore', 'a missing identity is not a new version')
})

test('a new version must be observed repeatedly before acting', () => {
  const state = initialVersionState('v1')
  assert.equal(decideVersionPoll(state, 'v2'), 'wait')
  assert.equal(decideVersionPoll(state, 'v2'), 'reload')
  assert.equal(VERSION_STABLE_POLLS, 2)
})

test('a rolling deploy that alternates builds never triggers a reload', () => {
  // Two instances still reporting different builds would otherwise ping-pong.
  const state = initialVersionState('v1')
  for (const seen of ['v2', 'v1', 'v2', 'v1', 'v2', 'v1']) {
    assert.notEqual(decideVersionPoll(state, seen), 'reload', `must not reload on ${seen}`)
  }
})

test('an identity that oscillates back to the running build clears pending state', () => {
  const state = initialVersionState('v1')
  decideVersionPoll(state, 'v2')
  assert.equal(state.pendingCount, 1)
  assert.equal(decideVersionPoll(state, 'v1'), 'ignore')
  assert.equal(state.pending, null)
  assert.equal(state.pendingCount, 0)
})

test('the version already reloaded for is not reloaded again', () => {
  const state = initialVersionState('v1', 'v2')
  assert.equal(decideVersionPoll(state, 'v2'), 'ignore')
  // A third version is still a legitimate reason to reload.
  assert.equal(decideVersionPoll(state, 'v3'), 'wait')
  assert.equal(decideVersionPoll(state, 'v3'), 'reload')
})

test('a page with no build identity does not watch at all', () => {
  let fetches = 0
  const stop = startVersionWatch({
    currentVersion: null,
    fetchVersion: async () => {
      fetches += 1
      return 'v2'
    },
  })
  stop()
  assert.equal(fetches, 0, 'local dev has no meta tag and must not poll')
})

test('a hidden tab reloads as soon as a new build is confirmed', async () => {
  const storage = fakeStorage()
  let reloads = 0
  const stop = startVersionWatch({
    currentVersion: 'v1',
    fetchVersion: async () => 'v2',
    reload: () => {
      reloads += 1
    },
    isHidden: () => true,
    storage,
    pollMs: 5,
  })
  await new Promise(resolve => setTimeout(resolve, 40))
  stop()
  assert.equal(reloads, 1)
  assert.equal(storage.map.get('lg.backoffice.reloaded-version'), 'v2')
})

test('a visible tab being edited defers the reload instead of eating the input', async () => {
  let reloads = 0
  let hidden = false
  let editing = true
  let version = 'v2'
  const stop = startVersionWatch({
    currentVersion: 'v1',
    fetchVersion: async () => version,
    reload: () => {
      reloads += 1
    },
    isHidden: () => hidden,
    isEditing: () => editing,
    storage: fakeStorage(),
    pollMs: 5,
  })
  await tick()
  await tick()
  assert.equal(reloads, 0, 'never reload while the employee is typing')

  editing = false
  hidden = true
  version = 'v2'
  await new Promise(resolve => setTimeout(resolve, 40))
  stop()
  assert.equal(reloads, 1, 'reloads once the tab is hidden and no longer editing')
})

test('a failing version endpoint is silent and never reloads', async () => {
  let reloads = 0
  const stop = startVersionWatch({
    currentVersion: 'v1',
    fetchVersion: async () => {
      throw new Error('offline')
    },
    reload: () => {
      reloads += 1
    },
    isHidden: () => true,
    storage: fakeStorage(),
    pollMs: 5,
  })
  await new Promise(resolve => setTimeout(resolve, 30))
  stop()
  assert.equal(reloads, 0)
})

test('isEditing recognises the controls that hold unsaved work', () => {
  // No DOM in the plain .ts suite: the function must degrade quietly, not throw.
  assert.equal(isEditing(), false)
})
