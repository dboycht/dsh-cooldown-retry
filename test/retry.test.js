import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_OPTIONS,
  apply,
  clampDelay,
  counterKey,
  createStats,
  extractDelayMs,
  formatStats,
  isCapacityFailure,
  isMislabeledModalityClientError,
  isRecentSaturation,
  planDelay,
  planMislabeledDelay,
  resolveOptions,
} from '../index.js'

/** The exact shape of the 429 a shared gateway returns during pool exhaustion. */
const COOLING_MESSAGE =
  'All upstream providers are cooling down. Please retry after 28 seconds.'

/**
 * The two gateway bodies observed in real session logs. Neither carries a hint
 * the client can act on, and the request behind them was plain text — no audio
 * anywhere. `MISLABELED_BODY` is the confusing one: it has no capacity keyword
 * at all, so it used to fall straight through to the built-in retry and fail
 * the turn even though the gateway was mid-storm.
 */
const MISLABELED_BODY =
  '400: {"type":"invalid_request_error","code":"400001","message":"Audio modality is not supported","source":"client","request_id":"a76477e5-aaa5-4d92-93c4-cfd34b74638d"}'
const CIRCUIT_BODY =
  '400: {"message":"HTTP 400: Audio modality is not supported","type":"upstream_client_error_circuit_open","code":"circuit.client_error","retry_after_sec":5}'

// ---------------------------------------------------------------------------
// Hint extraction.
// ---------------------------------------------------------------------------

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

test('extractDelayMs accepts a bare retryAfter field in seconds', () => {
  assert.equal(extractDelayMs({ retryAfter: 28, message: 'rate limited' }), 28000)
  assert.equal(extractDelayMs({ retryAfter: 0.5, message: 'rate limited' }), 500)
})

test('an explicit millisecond field still beats a bare retryAfter', () => {
  assert.equal(extractDelayMs({ providerRetryAfterMs: 1500, retryAfter: 28 }), 1500)
})

test('extractDelayMs returns undefined when the failure carries no hint', () => {
  const silentCooldown = { message: 'All upstream providers are cooling down.' }
  assert.equal(extractDelayMs(silentCooldown), undefined)
  assert.equal(extractDelayMs({ message: 'retry_after_seconds: 0' }), undefined)
  assert.equal(extractDelayMs({ message: '' }), undefined)
  assert.equal(extractDelayMs({ retryAfter: 0 }), undefined)
  assert.equal(extractDelayMs(undefined), undefined)
  assert.equal(extractDelayMs(null), undefined)
})

// ---------------------------------------------------------------------------
// Capacity classification: gateway prose AND the 429 shapes adapters mint.
// ---------------------------------------------------------------------------

test('isCapacityFailure recognizes capacity signals', () => {
  assert.equal(isCapacityFailure({ message: COOLING_MESSAGE }), true)
  assert.equal(isCapacityFailure({ code: 'upstream_capacity_exhausted' }), true)
  assert.equal(isCapacityFailure({ message: 'UPSTREAM CAPACITY' }), true)
})

test('isCapacityFailure recognizes the codes adapters mint for a 429', () => {
  assert.equal(isCapacityFailure({ message: 'nope', code: 'RATE_LIMIT' }), true)
  assert.equal(isCapacityFailure({ message: 'nope', code: 'rate_limit_exceeded' }), true)
  assert.equal(isCapacityFailure({ message: 'nope', code: 'QUOTA_EXCEEDED' }), true)
  assert.equal(isCapacityFailure({ message: 'nope', code: 'RESOURCE_EXHAUSTED' }), true)
  assert.equal(isCapacityFailure({ message: 'nope', code: 'TOO_MANY_REQUESTS' }), true)
  assert.equal(isCapacityFailure({ message: 'HTTP 429 Too Many Requests' }), true)
  assert.equal(isCapacityFailure({ message: 'model is overloaded, please retry' }), true)
  assert.equal(isCapacityFailure({ message: 'server busy' }), true)
})

test('isCapacityFailure ignores unrelated failures', () => {
  assert.equal(isCapacityFailure({ message: 'invalid api key' }), false)
  assert.equal(isCapacityFailure({ message: 'socket hang up' }), false)
  assert.equal(isCapacityFailure({ code: 'AUTH' }), false)
  assert.equal(isCapacityFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }), false)
  assert.equal(isCapacityFailure(undefined), false)
  assert.equal(isCapacityFailure(null), false)
})

test('a capacity cooldown with no hint is reported but not retried', () => {
  // apply() requires both signals; this documents the second half of that gate.
  const failure = { message: 'All upstream providers are cooling down.' }
  assert.equal(isCapacityFailure(failure), true)
  assert.equal(extractDelayMs(failure), undefined)
})

// ---------------------------------------------------------------------------
// The mislabeled client error: a saturation-era gateway answering an ordinary
// request with a modality 400, caching it in a client-error circuit, and then
// replaying it. The classifier must be narrow enough that a genuine rejection
// still reaches the caller untouched.
// ---------------------------------------------------------------------------

test('isMislabeledModalityClientError recognizes the gateway bodies verbatim', () => {
  const plain = { message: MISLABELED_BODY, code: 'INVALID_REQUEST' }
  assert.equal(isMislabeledModalityClientError(plain), true)
  assert.equal(isMislabeledModalityClientError({ message: CIRCUIT_BODY }), true)
  // The circuit form is also a capacity failure, which is why it never needed
  // this path — but the classifier must not disagree about its shape.
  assert.equal(isCapacityFailure({ message: CIRCUIT_BODY }), true)
})

test('isMislabeledModalityClientError leaves everything else alone', () => {
  assert.equal(isMislabeledModalityClientError({ message: 'invalid api key' }), false)
  assert.equal(
    isMislabeledModalityClientError({ message: 'Audio modality is not supported' }),
    false,
    'a bare modality line with no 400 / invalid-request envelope is not this bug',
  )
  assert.equal(
    isMislabeledModalityClientError({
      message: '400: {"type":"invalid_request_error","message":"Failed to deserialize the JSON body into the target type: messages[0].role: unknown variant `developer`"}',
    }),
    false,
    'a real schema rejection is not a modality complaint',
  )
  assert.equal(isMislabeledModalityClientError({ code: 'CONTEXT_WINDOW_EXCEEDED' }), false)
  assert.equal(isMislabeledModalityClientError({ code: 'INVALID_REQUEST' }), false)
  assert.equal(isMislabeledModalityClientError(undefined), false)
  assert.equal(isMislabeledModalityClientError(null), false)
})

test('planMislabeledDelay prefers a hint and otherwise backs off from its own base', () => {
  assert.deepEqual(planMislabeledDelay(1, 4000), { delayMs: 4000, source: 'hint' })
  assert.deepEqual(planMislabeledDelay(1, undefined), { delayMs: 15000, source: 'mislabeled-backoff' })
  assert.deepEqual(planMislabeledDelay(2, undefined), { delayMs: 30000, source: 'mislabeled-backoff' })
  assert.deepEqual(planMislabeledDelay(3, undefined), { delayMs: 60000, source: 'mislabeled-backoff' })
  assert.deepEqual(planMislabeledDelay(20, undefined), { delayMs: 300000, source: 'mislabeled-backoff' })
  const narrow = resolveOptions({ mislabeledBaseDelayMs: 500, minDelayMs: 100, maxDelayMs: 2000 })
  assert.deepEqual(planMislabeledDelay(4, undefined, narrow), { delayMs: 2000, source: 'mislabeled-backoff' })
})

test('isRecentSaturation only trusts a cooldown inside the evidence window', () => {
  assert.equal(isRecentSaturation(1000, 1500, 600), true)
  assert.equal(isRecentSaturation(1000, 1600, 600), true)
  assert.equal(isRecentSaturation(1000, 1601, 600), false)
  assert.equal(isRecentSaturation(undefined, 1500, 600), false)
})

// ---------------------------------------------------------------------------
// Delay planning and clamping.
// ---------------------------------------------------------------------------

test('clampDelay keeps the upstream request inside the configured window', () => {
  assert.equal(clampDelay(500), DEFAULT_OPTIONS.minDelayMs)
  assert.equal(clampDelay(28000), 28000)
  assert.equal(clampDelay(999999), DEFAULT_OPTIONS.maxDelayMs)
  assert.equal(clampDelay(5000, { minDelayMs: 100, maxDelayMs: 2000 }), 2000)
})

test('planDelay honours the upstream hint verbatim', () => {
  assert.deepEqual(planDelay(1, 28000), { delayMs: 28000, source: 'hint' })
  assert.deepEqual(planDelay(3, 900), { delayMs: 1000, source: 'hint' })
})

test('planDelay falls back to exponential growth without a hint', () => {
  const options = { ...DEFAULT_OPTIONS, hintlessBackoff: true, hintlessBaseDelayMs: 5000 }
  assert.deepEqual(planDelay(1, undefined, options), { delayMs: 5000, source: 'backoff' })
  assert.deepEqual(planDelay(2, undefined, options), { delayMs: 10000, source: 'backoff' })
  assert.deepEqual(planDelay(3, undefined, options), { delayMs: 20000, source: 'backoff' })
  // Still bounded by the same window.
  assert.deepEqual(planDelay(20, undefined, options), { delayMs: 300000, source: 'backoff' })
})

test('counterKey groups by turn when acrossSteps is on', () => {
  const entry = { turn: 2, step: 7, provider: 'nuaa' }
  assert.equal(counterKey(entry, DEFAULT_OPTIONS), '2:nuaa')
  assert.equal(counterKey(entry, { ...DEFAULT_OPTIONS, acrossSteps: false }), '2:7:nuaa')
})

// ---------------------------------------------------------------------------
// Options.
// ---------------------------------------------------------------------------

test('resolveOptions falls back to the defaults for junk values', () => {
  assert.deepEqual(resolveOptions(undefined), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions(null), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions({}), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions({ maxRetries: 0 }), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions({ maxRetries: 'many' }), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions({ minDelayMs: -5 }), DEFAULT_OPTIONS)
  assert.deepEqual(resolveOptions({ maxDelayMs: Number.NaN }), DEFAULT_OPTIONS)
  assert.equal(resolveOptions({ hintlessBackoff: 'yes' }).hintlessBackoff, false)
})

test('resolveOptions applies valid overrides', () => {
  assert.deepEqual(resolveOptions({ maxRetries: 10, minDelayMs: 250, maxDelayMs: 60000 }), {
    ...DEFAULT_OPTIONS,
    maxRetries: 10,
    minDelayMs: 250,
    maxDelayMs: 60000,
  })
})

test('resolveOptions carries the new counting and backoff options', () => {
  const options = resolveOptions({
    acrossSteps: false,
    hintlessBackoff: true,
    hintlessBaseDelayMs: 750,
  })
  assert.equal(options.acrossSteps, false)
  assert.equal(options.hintlessBackoff, true)
  assert.equal(options.hintlessBaseDelayMs, 750)
})

test('resolveOptions carries the mislabeled-400 options', () => {
  const options = resolveOptions({
    mislabeledClientError: false,
    mislabeledMaxRetries: 7,
    mislabeledBaseDelayMs: 2500,
    mislabeledEvidenceMs: 30000,
  })
  assert.equal(options.mislabeledClientError, false)
  assert.equal(options.mislabeledMaxRetries, 7)
  assert.equal(options.mislabeledBaseDelayMs, 2500)
  assert.equal(options.mislabeledEvidenceMs, 30000)
  assert.equal(resolveOptions({ mislabeledMaxRetries: 1e9 }).mislabeledMaxRetries, 100)
  assert.equal(
    resolveOptions({ mislabeledClientError: 'yes' }).mislabeledClientError,
    DEFAULT_OPTIONS.mislabeledClientError,
    'a junk flag falls back to the default',
  )
})

test('resolveOptions caps an absurd maxRetries', () => {
  assert.equal(resolveOptions({ maxRetries: 1e9 }).maxRetries, 100)
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
// Stats.
// ---------------------------------------------------------------------------

const ENTRY = { turn: 1, step: 1, provider: 'nuaa', waitMs: 28000, attempt: 1, maxRetries: 5 }

test('createStats tracks a wait in both the session and lifetime buckets', () => {
  const stats = createStats()
  stats.plan(ENTRY)
  assert.equal(stats.session.waits, 1)
  assert.equal(stats.session.totalWaitMs, 28000)
  assert.equal(stats.lifetime.waits, 1)
  assert.deepEqual(stats.session.byProvider, { nuaa: 1 })
  assert.equal(stats.session.last.attempt, 1)
})

test('createStats resets the session bucket but never the lifetime one', () => {
  const stats = createStats()
  stats.plan(ENTRY)
  stats.giveUp({ ...ENTRY, attempt: 5, waitMs: 0 })
  stats.skip({ ...ENTRY, waitMs: 0, attempt: 0 })

  stats.resetSession()

  assert.equal(stats.session.waits, 0)
  assert.equal(stats.session.giveUps, 0)
  assert.equal(stats.session.skipped, 0)
  assert.equal(stats.session.totalWaitMs, 0)
  assert.deepEqual(stats.session.byProvider, {})
  assert.equal(stats.session.last, undefined)

  assert.equal(stats.lifetime.waits, 1)
  assert.equal(stats.lifetime.giveUps, 1)
  assert.equal(stats.lifetime.skipped, 1)
})

test('formatStats renders every duration with exactly one unit', () => {
  const stats = createStats()
  // Sub-second, seconds and minutes exercise all three formatter branches; the
  // regression is a caller that appends its own 'ms' to a value that already
  // carries a unit, which rendered as "1.0sms".
  stats.plan({ ...ENTRY, waitMs: 900 })
  stats.plan({ ...ENTRY, waitMs: 28000, attempt: 2 })
  stats.plan({ ...ENTRY, waitMs: 120000, attempt: 3 })
  const text = formatStats(stats, DEFAULT_OPTIONS)
  assert.doesNotMatch(text, /sms\b/)
  assert.doesNotMatch(text, /[a-z]{2,}s\b.*\bms/)
  assert.match(text, /last: nuaa 2m|last: nuaa 120s/)
})

test('formatStats reports the counts and the window it is running with', () => {
  const stats = createStats()
  stats.plan(ENTRY)
  const text = formatStats(stats, resolveOptions({ maxRetries: 3, acrossSteps: false }))
  assert.match(text, /budget per turn\/step/)
  assert.match(text, /max 3 retries/)
  assert.match(text, /window 1000–300000ms/)
})

test('formatStats marks a hint-less backoff run', () => {
  const stats = createStats()
  const text = formatStats(stats, resolveOptions({ hintlessBackoff: true }))
  assert.match(text, /hint-less backoff on/)
})

test('formatStats advertises the mislabeled-400 takeover', () => {
  const stats = createStats()
  assert.match(formatStats(stats, DEFAULT_OPTIONS), /mislabeled-400 takeover on \(max 3\)/)
  assert.match(formatStats(stats, DEFAULT_OPTIONS), /mislabeled 400 retries 0/)
  assert.doesNotMatch(
    formatStats(stats, resolveOptions({ mislabeledClientError: false })),
    /mislabeled-400 takeover/,
  )
})

test('formatStats renders both buckets without leaking live objects', () => {
  const stats = createStats()
  stats.plan(ENTRY)
  stats.plan({ ...ENTRY, step: 2, provider: 'nuaa', waitMs: 2000, attempt: 2 })
  stats.giveUp({ ...ENTRY, attempt: 5, waitMs: 0 })
  const text = formatStats(stats, resolveOptions({ maxRetries: 5 }))
  assert.match(text, /this turn:/)
  assert.match(text, /lifetime:/)
  assert.match(text, /retries 2/)
  assert.match(text, /nuaa×2/)
  assert.match(text, /budget spent/)
  assert.doesNotMatch(text, /\[object Object\]/)
})

// ---------------------------------------------------------------------------
// apply() driven through a stub context, so the wiring itself is covered:
// what it owns, what it delegates, and how it counts.
// ---------------------------------------------------------------------------

const NEXT = { kind: 'delegated' }

function fakeContext({ withCommands = false, logger } = {}) {
  const listeners = new Map()
  const timers = []
  const registered = []
  const ctx = {
    timers,
    registered,
    logs: [],
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    effect(callback) {
      const disposer = callback()
      ctx.disposer = disposer
      return disposer
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
  if (logger !== undefined) ctx.logger = logger
  if (withCommands) {
    ctx.get = (service) => service === 'commands'
      ? {
        register: (definition) => {
          registered.push(definition)
          return () => { registered.length = 0 }
        },
      }
      : undefined
  } else {
    ctx.get = () => undefined
  }
  return ctx
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

test('apply() stops after maxRetries attempts for the same turn/provider', async () => {
  const ctx = fakeContext()
  apply(ctx, { maxRetries: 2 })

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = ctx.fail(payload())
    ctx.timers.at(-1).resolve()
    assert.deepEqual(await result, { kind: 'retry' })
  }

  assert.deepEqual(await ctx.fail(payload()), NEXT, 'the budget is spent')
})

test('apply() counts across steps by default, so a multi-step turn shares one budget', async () => {
  const ctx = fakeContext()
  apply(ctx, { maxRetries: 1 })

  const first = ctx.fail(payload({ step: 1 }))
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await first, { kind: 'retry' })

  assert.deepEqual(
    await ctx.fail(payload({ step: 2 })),
    NEXT,
    'step 2 must not get a fresh budget in the same turn',
  )
})

test('apply() gives each step its own budget when acrossSteps is off', async () => {
  const ctx = fakeContext()
  apply(ctx, { maxRetries: 1, acrossSteps: false })

  const first = ctx.fail(payload({ step: 1 }))
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await first, { kind: 'retry' })

  const second = ctx.fail(payload({ step: 2 }))
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await second, { kind: 'retry' }, 'a different step gets its own budget')
})

test('apply() resets every budget when a new turn starts', async () => {
  const ctx = fakeContext()
  apply(ctx, { maxRetries: 1 })

  const first = ctx.fail(payload({ turn: 1 }))
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await first, { kind: 'retry' })
  assert.deepEqual(await ctx.fail(payload({ turn: 1 })), NEXT)

  const secondTurn = ctx.fail(payload({ turn: 2 }))
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await secondTurn, { kind: 'retry' }, 'turn 2 starts with a full budget')
})

test('apply() counts each provider independently', async () => {
  const ctx = fakeContext()
  apply(ctx, { maxRetries: 1 })

  const nuaa = ctx.fail(payload({ provider: 'nuaa' }))
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await nuaa, { kind: 'retry' })

  const other = ctx.fail(payload({ provider: 'deepseek' }))
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await other, { kind: 'retry' }, 'another provider has its own budget')
})

test('apply() keeps delegating a hint-less cooldown unless backoff is enabled', async () => {
  const ctx = fakeContext()
  apply(ctx, undefined)

  const failure = { message: 'All upstream providers are cooling down.' }
  assert.deepEqual(await ctx.fail(payload({ failure })), NEXT)
  assert.equal(ctx.timers.length, 0)
})

test('apply() retries a hint-less cooldown once hintlessBackoff is on', async () => {
  const ctx = fakeContext()
  apply(ctx, { hintlessBackoff: true, hintlessBaseDelayMs: 5000, maxRetries: 2 })

  const first = ctx.fail(payload({ failure: { message: 'All upstream providers are cooling down.' } }))
  assert.equal(ctx.timers.at(-1).ms, 5000, 'attempt 1 uses the base delay')
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await first, { kind: 'retry' })

  const second = ctx.fail(payload({ failure: { message: 'All upstream providers are cooling down.' } }))
  assert.equal(ctx.timers.at(-1).ms, 10000, 'attempt 2 doubles it')
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await second, { kind: 'retry' })
})

test('apply() abandons the wait when the turn is aborted', async () => {
  const ctx = fakeContext()
  apply(ctx, undefined)

  const controller = new AbortController()
  const result = ctx.fail(payload({ signal: controller.signal }))
  controller.abort()
  assert.equal(await result, undefined)
})

test('apply() declines immediately when the signal was already aborted', async () => {
  const ctx = fakeContext()
  apply(ctx, undefined)

  const controller = new AbortController()
  controller.abort()
  const result = ctx.fail(payload({ signal: controller.signal }))
  assert.equal(await result, undefined, 'an aborted turn is not owned')
  // The wait is skipped rather than armed — but the attempt is still spent, so
  // a repeatedly aborted turn cannot loop forever.
  assert.equal(ctx.timers.length, 0)
})

// ---------------------------------------------------------------------------
// Observability: logger lines and the optional `/cooldown-retry` command.
// ---------------------------------------------------------------------------

test('apply() resets the session counters when a skipped failure opens a new turn', async () => {
  // Regression: the turn bookkeeping used to live inside the attempt counter,
  // which the skip path returns before ever reaching. A new turn whose first
  // failure carried no hint therefore kept the previous turn's session stats.
  const ctx = fakeContext({ withCommands: true })
  apply(ctx, { hintlessBackoff: false })

  const owned = ctx.fail(payload({ turn: 1 }))
  ctx.timers.at(-1).resolve()
  await owned
  assert.match(ctx.registered[0].handler({}).text, /this turn: retries 1/)

  // Turn 2 opens with an unowned, hint-less capacity cooldown.
  const silent = { message: 'All upstream providers are cooling down.' }
  assert.deepEqual(await ctx.fail(payload({ turn: 2, failure: silent })), NEXT)

  const report = ctx.registered[0].handler({}).text
  const session = report.split('\n')[1]
  assert.match(session, /retries 0/, 'the new turn starts with a clean session bucket')
  assert.match(report, /lifetime: {2}retries 1/, 'the lifetime bucket still remembers turn 1')
})

test('apply() attributes a skipped failure to the turn it arrived in', async () => {
  const ctx = fakeContext({ withCommands: true })
  apply(ctx, undefined)

  const silent = { message: 'All upstream providers are cooling down.' }
  await ctx.fail(payload({ turn: 7, step: 4, failure: silent }))

  const session = ctx.registered[0].handler({}).text.split('\n')[1]
  assert.match(session, /no-hint capacity failures 1/)
  assert.match(session, /last: nuaa 0ms \(0\/5\) — no hint/)
})

test('apply() keeps counters, turn accounting and logging apart per provider', async () => {
  const logs = []
  const logger = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) }
  const ctx = fakeContext({ logger })
  apply(ctx, { maxRetries: 1 })

  const nuaa = ctx.fail(payload({ provider: 'nuaa' }))
  ctx.timers.at(-1).resolve()
  await nuaa

  const deepseek = ctx.fail(payload({ provider: 'deepseek' }))
  ctx.timers.at(-1).resolve()
  await deepseek

  assert.equal(logs.length, 2)
  assert.match(logs[0][1], /cooling down for nuaa/)
  assert.match(logs[1][1], /cooling down for deepseek/)
  // Both fits in the same turn, so the session bucket aggregates them.
  assert.deepEqual(
    await ctx.fail(payload({ provider: 'nuaa' })),
    NEXT,
    'nuaa spent its own budget without touching deepseek\'s',
  )
})

test('apply() reports through ctx.logger when one is available', async () => {
  const logs = []
  const logger = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) }
  const ctx = fakeContext({ logger })
  apply(ctx, undefined)

  const result = ctx.fail(payload())
  ctx.timers.at(-1).resolve()
  await result

  assert.equal(logs.length, 1)
  assert.equal(logs[0][0], 'info')
  assert.match(logs[0][1], /upstream cooling down for nuaa/)
  assert.match(logs[0][1], /retrying in 28000ms \(1\/5\)/)
})

test('apply() mounts without the commands service', async () => {
  const ctx = fakeContext()
  apply(ctx, undefined)
  assert.deepEqual(ctx.registered, [], 'no command is registered when the service is absent')
  // It still retries.
  const result = ctx.fail(payload())
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await result, { kind: 'retry' })
})

test('apply() registers /cooldown-retry with a report of the counters', async () => {
  const ctx = fakeContext({ withCommands: true })
  apply(ctx, undefined)

  assert.equal(ctx.registered.length, 1)
  const command = ctx.registered[0]
  assert.equal(command.name, 'cooldown-retry')
  assert.match(command.description, /cooldown-retry/)

  const before = command.handler({})
  assert.equal(before.kind, 'success')
  assert.match(before.text, /retries 0/)

  const result = ctx.fail(payload())
  ctx.timers.at(-1).resolve()
  await result

  const after = command.handler({})
  assert.match(after.text, /retries 1/)
  assert.match(after.text, /nuaa×1/)
})

test('apply() disposes the listener, the command and the counters together', async () => {
  const ctx = fakeContext({ withCommands: true })
  apply(ctx, undefined)
  assert.equal(typeof ctx.disposer, 'function')
  ctx.disposer()
  assert.deepEqual(ctx.registered, [], 'the command disposer ran')
})

// ---------------------------------------------------------------------------
// apply() + the mislabeled client error. The gate is the point: the same 400 is
// retried only when the provider cooldown that caused the circuit is recent.
// ---------------------------------------------------------------------------

const MISLABELED_FAILURE = { message: MISLABELED_BODY, code: 'INVALID_REQUEST' }

test('apply() delegates a modality 400 that has no recent cooldown behind it', async () => {
  const logs = []
  const logger = { info: (m) => logs.push(m), warn: () => {} }
  const ctx = fakeContext({ logger })
  apply(ctx, undefined)

  assert.deepEqual(await ctx.fail(payload({ failure: MISLABELED_FAILURE })), NEXT)
  assert.equal(ctx.timers.length, 0, 'a real client error must not arm a timer')
  assert.match(logs[0], /no recent capacity cooldown/)
})

test('apply() waits out a circuit replay that follows a cooldown', async () => {
  const ctx = fakeContext()
  apply(ctx, undefined)

  const cooldown = ctx.fail(payload())
  assert.equal(ctx.timers.at(-1).ms, 28000)
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await cooldown, { kind: 'retry' })

  const replay = ctx.fail(payload({ step: 2, failure: MISLABELED_FAILURE }))
  assert.equal(ctx.timers.at(-1).ms, DEFAULT_OPTIONS.mislabeledBaseDelayMs)
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await replay, { kind: 'retry' })
})

test('apply() gives circuit replays a budget of their own', async () => {
  // The 429 budget is deliberately spent first: waiting out the circuit is a
  // separate policy, so one must not starve the other.
  const ctx = fakeContext()
  apply(ctx, { maxRetries: 1, mislabeledMaxRetries: 2 })

  const cooldown = ctx.fail(payload())
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await cooldown, { kind: 'retry' })
  assert.deepEqual(await ctx.fail(payload()), NEXT, 'the 429 budget is spent')

  const first = ctx.fail(payload({ failure: MISLABELED_FAILURE }))
  assert.equal(ctx.timers.at(-1).ms, 15000, 'attempt 1 uses the base delay')
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await first, { kind: 'retry' })

  const second = ctx.fail(payload({ failure: MISLABELED_FAILURE }))
  assert.equal(ctx.timers.at(-1).ms, 30000, 'attempt 2 doubles it')
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await second, { kind: 'retry' })

  assert.deepEqual(
    await ctx.fail(payload({ failure: MISLABELED_FAILURE })),
    NEXT,
    'the replay budget is bounded too',
  )
})

test('apply() still takes over a replay in a later turn of the same episode', async () => {
  // The client-error circuit outlives the turn that opened it, so evidence is
  // tracked per provider rather than per turn.
  const ctx = fakeContext()
  apply(ctx, undefined)

  const cooldown = ctx.fail(payload({ turn: 1 }))
  ctx.timers.at(-1).resolve()
  await cooldown

  const replay = ctx.fail(payload({ turn: 2, failure: MISLABELED_FAILURE }))
  assert.equal(ctx.timers.at(-1).ms, DEFAULT_OPTIONS.mislabeledBaseDelayMs)
  ctx.timers.at(-1).resolve()
  assert.deepEqual(await replay, { kind: 'retry' })
})

test('apply() forgets the evidence once the window has passed', async () => {
  const ctx = fakeContext()
  apply(ctx, { mislabeledEvidenceMs: 1 })

  const cooldown = ctx.fail(payload())
  ctx.timers.at(-1).resolve()
  await cooldown

  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(await ctx.fail(payload({ failure: MISLABELED_FAILURE })), NEXT)
})

test('apply() leaves modality 400s alone when the takeover is off', async () => {
  const ctx = fakeContext()
  apply(ctx, { mislabeledClientError: false })

  const cooldown = ctx.fail(payload())
  ctx.timers.at(-1).resolve()
  await cooldown

  assert.deepEqual(await ctx.fail(payload({ failure: MISLABELED_FAILURE })), NEXT)
  assert.equal(ctx.timers.length, 1, 'no second timer was armed')
})

test('apply() logs and reports circuit-replay retries distinctly', async () => {
  const logs = []
  const logger = { info: (m) => logs.push(m), warn: () => {} }
  const ctx = fakeContext({ withCommands: true, logger })
  apply(ctx, undefined)

  const cooldown = ctx.fail(payload())
  ctx.timers.at(-1).resolve()
  await cooldown
  logs.length = 0

  const replay = ctx.fail(payload({ failure: MISLABELED_FAILURE }))
  ctx.timers.at(-1).resolve()
  await replay

  assert.equal(logs.length, 1)
  assert.match(logs[0], /modality is not supported/)
  assert.match(logs[0], /circuit replay/)

  const text = ctx.registered[0].handler({}).text
  assert.match(text, /mislabeled 400 retries 1/)
  assert.match(text, /last: nuaa 15\.0s \(1\/3\) — mislabeled 400/)
})
