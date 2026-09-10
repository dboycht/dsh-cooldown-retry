import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_OPTIONS,
  apply,
  clampDelay,
  extractDelayMs,
  isCapacityFailure,
  resolveOptions,
} from '../index.js'

/** The exact shape of the 429 a shared gateway returns during pool exhaustion. */
const COOLING_MESSAGE =
  'All upstream providers are cooling down. Please retry after 28 seconds.'

test('extractDelayMs reads the prose hint from a real cooling-down 429', () => {
  assert.equal(extractDelayMs({ message: COOLING_MESSAGE }), 28000)
})

test('extractDelayMs prefers an explicit providerRetryAfterMs field', () => {
  assert.equal(extractDelayMs({ providerRetryAfterMs: 15000, message: COOLING_MESSAGE }), 15000)
})

test('extractDelayMs reads retry_after_seconds from a JSON body', () => {
  assert.equal(extractDelayMs({ message: '{"error":{"retry_after_seconds":28}}' }), 28000)
  assert.equal(extractDelayMs({ message: 'retry_after_seconds: 3.5' }), 3500)
})

test('extractDelayMs reads retry_after_ms verbatim', () => {
  assert.equal(extractDelayMs({ message: 'retry_after_ms=1500' }), 1500)
})

test('extractDelayMs returns undefined when the failure carries no hint', () => {
  const silentCooldown = { message: 'All upstream providers are cooling down.' }
  assert.equal(extractDelayMs(silentCooldown), undefined)
  assert.equal(extractDelayMs({ message: 'retry_after_seconds: 0' }), undefined)
  assert.equal(extractDelayMs({ message: '' }), undefined)
  assert.equal(extractDelayMs(undefined), undefined)
  assert.equal(extractDelayMs(null), undefined)
})

test('isCapacityFailure recognizes capacity signals', () => {
  assert.equal(isCapacityFailure({ message: COOLING_MESSAGE }), true)
  assert.equal(isCapacityFailure({ code: 'upstream_capacity_exhausted' }), true)
  assert.equal(isCapacityFailure({ message: 'UPSTREAM CAPACITY' }), true)
})

test('isCapacityFailure ignores unrelated failures', () => {
  assert.equal(isCapacityFailure({ message: 'invalid api key' }), false)
  assert.equal(isCapacityFailure({ message: 'socket hang up' }), false)
  assert.equal(isCapacityFailure(undefined), false)
  assert.equal(isCapacityFailure(null), false)
})

test('a capacity cooldown with no hint is reported but not retried', () => {
  // apply() requires both signals; this documents the second half of that gate.
  const failure = { message: 'All upstream providers are cooling down.' }
  assert.equal(isCapacityFailure(failure), true)
  assert.equal(extractDelayMs(failure), undefined)
})

test('clampDelay keeps the upstream request inside the configured window', () => {
  assert.equal(clampDelay(500), DEFAULT_OPTIONS.minDelayMs)
  assert.equal(clampDelay(28000), 28000)
  assert.equal(clampDelay(999999), DEFAULT_OPTIONS.maxDelayMs)
  assert.equal(clampDelay(5000, { minDelayMs: 100, maxDelayMs: 2000 }), 2000)
})

test('resolveOptions falls back to the defaults for junk values', () => {
  assert.deepEqual(resolveOptions(undefined), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions(null), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions({}), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions({ maxRetries: 0 }), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions({ maxRetries: 'many' }), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions({ minDelayMs: -5 }), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions({ maxDelayMs: Number.NaN }), DEFAULT_OPTIONS)
})

test('resolveOptions applies valid overrides', () => {
  assert.deepEqual(resolveOptions({ maxRetries: 10, minDelayMs: 250, maxDelayMs: 60000 }), {
    maxRetries: 10,
    minDelayMs: 250,
    maxDelayMs: 60000,
  })
})

test('resolveOptions never leaves an inverted delay window', () => {
  const options = resolveOptions({ minDelayMs: 5000, maxDelayMs: 1000 })
  assert.equal(options.minDelayMs, 5000)
  assert.equal(options.maxDelayMs, 5000)
})

// ---------------------------------------------------------------------------
// Regression: the hint patterns must survive every separator style.
//
// The original implementation used /retry-?after/, which matches neither
// `retry_after` (underscore) nor `retry after` (space) — so it silently
// declined the exact gateway error this plugin exists to handle.
// ---------------------------------------------------------------------------

test('extractDelayMs accepts snake_case, kebab-case and spaced hint forms', () => {
  assert.equal(extractDelayMs({ message: 'retry_after: 5' }), 5000)
  assert.equal(extractDelayMs({ message: 'retry-after: 5' }), 5000)
  assert.equal(extractDelayMs({ message: 'Retry-After: 12' }), 12000)
  assert.equal(extractDelayMs({ message: '{"retry_after": 7}' }), 7000)
})

test('extractDelayMs understands prose that puts the number first', () => {
  assert.equal(extractDelayMs({ message: 'Please retry after 28 seconds.' }), 28000)
  assert.equal(extractDelayMs({ message: 'Please try again in 30 seconds' }), 30000)
  assert.equal(extractDelayMs({ message: 'retry in 3.5 secs' }), 3500)
})

test('a millisecond hint is never misread as seconds', () => {
  // Ordering trap: the unit-qualified prose pattern must win over the bare
  // pattern, or "after 1500 ms" becomes 1500 seconds.
  assert.equal(extractDelayMs({ message: 'Please retry after 1500 ms' }), 1500)
  assert.equal(extractDelayMs({ message: 'slow down, try again in 250 ms' }), 250)
  assert.equal(extractDelayMs({ message: 'retry-after-ms: 900' }), 900)
})

// ---------------------------------------------------------------------------
// apply() driven through a stub context, so the wiring itself is covered:
// what it owns, what it delegates, and how it counts.
// ---------------------------------------------------------------------------

const NEXT = { kind: 'delegated' }

function fakeContext() {
  const listeners = new Map()
  const timers = []
  return {
    timers,
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(callback) {
      return callback()
    },
    timeout(ms) {
      return new Promise((resolve, reject) => { timers.push({ ms, resolve, reject }) })
    },
    fail(payload) {
      const listener = listeners.get('agent/request-error')
      assert.ok(listener !== undefined, 'plugin registered no agent/request-error listener')
      return listener(payload, async () => NEXT)
    },
  }
}

function payload(extra = {}) {
  return {
    turn: 1,
    step: 1,
    provider: 'nuaa',
    failure: { message: COOLING_MESSAGE },
    ...extra,
  }
}

test('apply() waits the upstream delay and then owns the retry', async () => {
  const ctx = fakeContext()
  apply(ctx, undefined)

  const result = ctx.fail(payload())
  assert.equal(ctx.timers.length, 1)
  assert.equal(ctx.timers[0].ms, 28000)

  ctx.timers[0].resolve()
  assert.deepEqual(await result, { kind: 'retry' })
})

test('apply() delegates failures it does not own', async () => {
  const ctx = fakeContext()
  apply(ctx, undefined)

  assert.deepEqual(await ctx.fail(payload({ failure: { message: 'invalid api key' } })), NEXT)
  assert.deepEqual(await ctx.fail(payload({ failure: { message: 'cooling down, no hint' } })), NEXT)
  assert.deepEqual(await ctx.fail(payload({ failure: undefined })), NEXT)
  assert.equal(ctx.timers.length, 0, 'no timer may be armed for a delegated failure')
})

test('apply() honours a custom config window', async () => {
  const ctx = fakeContext()
  apply(ctx, { minDelayMs: 100, maxDelayMs: 2000 })

  const result = ctx.fail(payload())
  assert.equal(ctx.timers[0].ms, 2000, 'a 28s hint is clamped to maxDelayMs')
  ctx.timers[0].resolve()
  assert.deepEqual(await result, { kind: 'retry' })
})

test('apply() stops after maxRetries attempts for the same turn/step/provider', async () => {
  const ctx = fakeContext()
  apply(ctx, { maxRetries: 2 })

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = ctx.fail(payload())
    ctx.timers.at(-1).resolve()
    assert.deepEqual(await result, { kind: 'retry' })
  }

  assert.deepEqual(await ctx.fail(payload()), NEXT, 'the budget is spent')
})

test('apply() counts each turn/step/provider independently', async () => {
  const ctx = fakeContext()
  apply(ctx, { maxRetries: 1 })

  const first = ctx.fail(payload({ step: 1 }))
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await first, { kind: 'retry' })

  const second = ctx.fail(payload({ step: 2 }))
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await second, { kind: 'retry' }, 'a different step gets its own budget')
})

test('apply() abandons the wait when the turn is aborted', async () => {
  const ctx = fakeContext()
  apply(ctx, undefined)

  const controller = new AbortController()
  const result = ctx.fail(payload({ signal: controller.signal }))
  controller.abort()
  assert.equal(await result, undefined)
})
