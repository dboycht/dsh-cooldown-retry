/**
 * The durable retry journal.
 *
 * A wait this plugin owns used to be invisible. These tests pin the records that
 * make the console's own chat view render a `model-retry` card — a live
 * countdown plus the attempt number — for our wait, and pin the exact field
 * contract `dsh-llm-retry`'s invariant enforces at the durable boundary.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPACITY_POLICY_KEY,
  MISLABELED_POLICY_KEY,
  apply,
  createRetryJournal,
  mintRetryId,
  sanitizeFailure,
} from '../index.js'

const COOLING = 'All upstream providers are cooling down. Please retry after 28 seconds.'

/** A session stub shaped like the real one at the durable boundary. */
function fakeSession(history = []) {
  const events = history.slice()
  return {
    events,
    appends: [],
    append(type, data) {
      this.appends.push({ type, data })
      events.push({ type, data, seq: events.length + 1, time: events.length })
    },
    snapshotEvents() {
      return events
    },
  }
}

const ENTRY = { turn: 1, step: 1, provider: 'nuaa', failure: { message: COOLING, code: 'RATE_LIMIT' } }

// ---------------------------------------------------------------------------
// sanitizeFailure — the durable boundary rejects a malformed known field, and
// the raw failure comes from a provider adapter we do not control.
// ---------------------------------------------------------------------------

test('sanitizeFailure keeps a usable failure unchanged', () => {
  const failure = { message: COOLING, code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 28000, requestId: 'req-1' }
  assert.deepEqual(sanitizeFailure(failure, 'FALLBACK'), failure)
})

test('sanitizeFailure fills the non-empty message and code the boundary requires', () => {
  assert.deepEqual(sanitizeFailure({}, 'FALLBACK'), { message: 'model request failed', code: 'FALLBACK' })
  assert.deepEqual(sanitizeFailure(undefined, 'FALLBACK'), { message: 'model request failed', code: 'FALLBACK' })
  assert.deepEqual(sanitizeFailure({ message: '', code: '' }, 'FALLBACK'), {
    message: 'model request failed',
    code: 'FALLBACK',
  })
})

test('sanitizeFailure drops every optional field the boundary would reject', () => {
  const clean = sanitizeFailure({
    message: 'x',
    code: 'y',
    status: 0,
    providerRetryAfterMs: Number.NaN,
    requestId: '',
  }, 'FALLBACK')
  assert.deepEqual(clean, { message: 'x', code: 'y' })
  assert.deepEqual(sanitizeFailure({ message: 'x', code: 'y', status: 99 }, 'F'), { message: 'x', code: 'y' })
  assert.deepEqual(
    sanitizeFailure({ message: 'x', code: 'y', providerRetryAfterMs: -1 }, 'F'),
    { message: 'x', code: 'y' },
  )
})

test('mintRetryId returns a fresh non-empty id', () => {
  const first = mintRetryId(1000, 0.5)
  const second = mintRetryId(1000, 0.5)
  assert.match(first, /^cooldown-retry-/)
  assert.notEqual(first, second)
})

// ---------------------------------------------------------------------------
// The journal itself.
// ---------------------------------------------------------------------------

test('schedule appends a scheduled attempt before its wait', () => {
  const session = fakeSession()
  const journal = createRetryJournal()
  const chain = journal.schedule(session, ENTRY, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT')

  assert.deepEqual(session.appends.map((entry) => entry.type), ['llm/retry'])
  const [record] = session.appends
  assert.equal(record.data.turn, 1)
  assert.equal(record.data.step, 1)
  assert.equal(record.data.provider, 'nuaa')
  assert.equal(record.data.mode, 'normal')
  assert.equal(record.data.policyKey, CAPACITY_POLICY_KEY)
  assert.equal(record.data.retry, 1)
  assert.equal(record.data.maxRetries, 5)
  assert.equal(record.data.delayMs, 30000)
  assert.deepEqual(record.data.failure, { message: COOLING, code: 'RATE_LIMIT' })
  assert.equal(chain.retry, 1)
  assert.equal(chain.retryId, record.data.retryId)
})

test('one chain keeps its retryId and counts up; another step gets its own', () => {
  const session = fakeSession()
  const journal = createRetryJournal()
  const first = journal.schedule(session, ENTRY, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT')
  const second = journal.schedule(session, ENTRY, CAPACITY_POLICY_KEY, 60000, 5, 'RATE_LIMIT')
  const otherStep = journal.schedule(session, { ...ENTRY, step: 2 }, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT')

  assert.equal(second.retry, 2)
  assert.equal(second.retryId, first.retryId)
  assert.equal(otherStep.retry, 1)
  assert.notEqual(otherStep.retryId, first.retryId)
})

test('a fresh journal continues the chain it finds in durable history', () => {
  // A resumed session, or a plugin remount mid-turn: the invariant derives its
  // expectation from the log, so the journal must too.
  const seeded = { turn: 1, step: 1, provider: 'nuaa', policyKey: CAPACITY_POLICY_KEY, retry: 3, retryId: 'seeded-id' }
  const session = fakeSession([{ type: 'llm/retry', data: seeded, seq: 1, time: 0 }])
  const chain = createRetryJournal().schedule(session, ENTRY, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT')

  assert.equal(chain.retry, 4)
  assert.equal(chain.retryId, 'seeded-id')
})

test('a different policyKey is a different chain on the same step', () => {
  const session = fakeSession()
  const journal = createRetryJournal()
  const capacity = journal.schedule(session, ENTRY, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT')
  const mislabeled = journal.schedule(session, ENTRY, MISLABELED_POLICY_KEY, 15000, 3, 'INVALID_REQUEST')

  assert.equal(mislabeled.retry, 1)
  assert.notEqual(mislabeled.retryId, capacity.retryId)
})

test('markStarted pairs the scheduled attempt', () => {
  const session = fakeSession()
  const journal = createRetryJournal()
  const chain = journal.schedule(session, ENTRY, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT')
  journal.markStarted(session, chain, ENTRY)

  assert.deepEqual(session.appends.map((entry) => entry.type), ['llm/retry', 'llm/retry-started'])
  assert.deepEqual(session.appends[1].data, { retryId: chain.retryId, turn: 1, step: 1, retry: 1 })
})

test('clear drops the chains, as a new turn must', () => {
  const session = fakeSession()
  const journal = createRetryJournal()
  journal.schedule(session, ENTRY, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT')
  journal.clear()
  // A new turn: the invariant numbers per turn/step/provider/policyKey, so the
  // chain legitimately starts over here even though history keeps the old record.
  const nextTurn = journal.schedule(session, { ...ENTRY, turn: 2 }, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT')
  assert.equal(nextTurn.retry, 1)
})

test('a missing session, or a refused append, degrades to no record — never a throw', () => {
  const journal = createRetryJournal()
  assert.equal(journal.schedule(undefined, ENTRY, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT'), undefined)

  const refusing = {
    append() { throw new Error('session is closed') },
    snapshotEvents() { return [] },
  }
  const reported = []
  const watched = createRetryJournal((message) => reported.push(message))
  assert.equal(watched.schedule(refusing, ENTRY, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT'), undefined)
  assert.equal(reported.length, 1)
  assert.match(reported[0], /llm\/retry refused: session is closed/)
  // The chain must not be poisoned by the failure: the next attempt starts over.
  const good = fakeSession()
  assert.equal(watched.schedule(good, ENTRY, CAPACITY_POLICY_KEY, 30000, 5, 'RATE_LIMIT').retry, 1)
})

test('markStarted tolerates a missing session', () => {
  const journal = createRetryJournal()
  assert.doesNotThrow(() => journal.markStarted(undefined, { retryId: 'x', retry: 1 }, ENTRY))
})

// ---------------------------------------------------------------------------
// Through apply(): the wiring, including the order the console depends on.
// ---------------------------------------------------------------------------

const NEXT = { kind: 'delegated' }

function fakeContext() {
  const listeners = new Map()
  const timers = []
  return {
    timers,
    logger: undefined,
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(callback) { return callback() },
    get() { return undefined },
    timeout(ms) { return new Promise((resolve) => { timers.push({ ms, resolve }) }) },
    fail(payload) { return listeners.get('agent/request-error')(payload, async () => NEXT) },
  }
}

function payloadFor(session, extra = {}) {
  return {
    turn: 1,
    step: 1,
    provider: 'nuaa',
    failure: { message: COOLING },
    agent: { session },
    ...extra,
  }
}

test('apply() journals the wait, then pairs it when the wait completes', async () => {
  const session = fakeSession()
  const ctx = fakeContext()
  apply(ctx, { minDelayMs: 30000 })

  const result = ctx.fail(payloadFor(session))
  assert.deepEqual(session.appends.map((entry) => entry.type), ['llm/retry'], 'the record lands before the wait')
  assert.equal(session.appends[0].data.delayMs, 30000)

  ctx.timers[0].resolve()
  assert.deepEqual(await result, { kind: 'retry' })
  assert.deepEqual(session.appends.map((entry) => entry.type), ['llm/retry', 'llm/retry-started'])
})

test('an aborted wait leaves the attempt unpaired, because it never started', async () => {
  const session = fakeSession()
  const ctx = fakeContext()
  apply(ctx, { minDelayMs: 30000 })

  const controller = new AbortController()
  const result = ctx.fail(payloadFor(session, { signal: controller.signal }))
  controller.abort()
  assert.equal(await result, undefined)
  assert.deepEqual(session.appends.map((entry) => entry.type), ['llm/retry'])
})

test('a payload without an agent still retries, it just cannot journal', async () => {
  const ctx = fakeContext()
  apply(ctx, { minDelayMs: 30000 })

  const result = ctx.fail({ turn: 1, step: 1, provider: 'nuaa', failure: { message: COOLING } })
  ctx.timers[0].resolve()
  assert.deepEqual(await result, { kind: 'retry' })
})
