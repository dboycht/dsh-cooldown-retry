/**
 * dsh-cooldown-retry — honor the upstream's own backoff request on a 429
 * capacity cooldown, instead of letting the built-in fast retry give up.
 *
 * Plain ESM, zero dependencies. Loadable as one composition row:
 *
 *   - insert:
 *       - id: cooldown-retry
 *         name: dsh-cooldown-retry
 *
 * It listens to the `agent/request-error` waterfall. When the failure looks like
 * an upstream capacity cooldown AND carries a retry hint, it waits that long and
 * returns `{ kind: 'retry' }` to own the recovery. Anything else is delegated to
 * the next listener — and ultimately to the built-in `llm-retry` — by `next()`.
 *
 * Observability is deliberately dependency-free: counters live in memory, are
 * logged through `ctx.logger`, and are queryable from the composer with
 * `/cooldown-retry`. The command registration is opportunistic — a context
 * without the `commands` service still mounts and still retries.
 */

export const name = 'cooldown-retry'

/**
 * The timer mixin (`ctx.timeout` / `ctx.interval`) is a hard dependency; every
 * other service this plugin touches (`commands`, `logger`) is optional.
 */
export const inject = ['timer']

/** Defaults. Override per row with `config: { ... }`. */
export const DEFAULT_OPTIONS = Object.freeze({
  maxRetries: 5,
  minDelayMs: 1000,
  maxDelayMs: 300000,
  /**
   * Count retries per turn instead of per turn:step. A multi-step turn that
   * trips the same provider cooldown in every step would otherwise get a fresh
   * budget per step and never reach `maxRetries`.
   */
  acrossSteps: true,
  /**
   * Also take over a capacity failure that carries NO hint, using an
   * exponential backoff (`hintlessBaseDelayMs * 2^(attempt-1)`). Off by
   * default: hint-less throttling is indistinguishable from a permanent
   * capacity problem, and retrying it is a policy change, not a bug fix.
   */
  hintlessBackoff: false,
  hintlessBaseDelayMs: 5000,
})

/** The `maxRetries` window used when a row sets an unusable value. */
const MAX_RETRY_CEILING = 100

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function flag(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Merge a row's `config` over the defaults, ignoring unusable values. */
export function resolveOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const options = { ...DEFAULT_OPTIONS }
  if (positiveNumber(source.maxRetries)) {
    options.maxRetries = Math.min(Math.floor(source.maxRetries), MAX_RETRY_CEILING)
  }
  if (positiveNumber(source.minDelayMs)) options.minDelayMs = Math.floor(source.minDelayMs)
  if (positiveNumber(source.maxDelayMs)) options.maxDelayMs = Math.floor(source.maxDelayMs)
  options.acrossSteps = flag(source.acrossSteps, DEFAULT_OPTIONS.acrossSteps)
  options.hintlessBackoff = flag(source.hintlessBackoff, DEFAULT_OPTIONS.hintlessBackoff)
  if (positiveNumber(source.hintlessBaseDelayMs)) {
    options.hintlessBaseDelayMs = Math.floor(source.hintlessBaseDelayMs)
  }
  // An inverted window would make clamp() return maxDelayMs forever; keep it sane.
  if (options.maxDelayMs < options.minDelayMs) options.maxDelayMs = options.minDelayMs
  return options
}

/**
 * Does this failure look like "the upstream pool is out of capacity"?
 * Matched case-insensitively against `message` + `code`.
 *
 * The message side covers gateway prose; the code side covers the 429 shapes
 * adapters mint (`RATE_LIMIT`, `QUOTA_EXCEEDED`, `RESOURCE_EXHAUSTED`,
 * `TOO_MANY_REQUESTS`, `rate_limit_exceeded`, …). Both matter: some gateways
 * collapse the body to a bare status line, and some adapters replace the
 * message with their own classification.
 */
export function isCapacityFailure(failure) {
  if (failure === undefined || failure === null) return false
  const text = (typeof failure.message === 'string' ? failure.message : '')
    + ' ' + (typeof failure.code === 'string' ? failure.code : '')
  return CAPACITY_PATTERN.test(text)
}

const CAPACITY_PATTERN = new RegExp([
  // Pool / breaker prose.
  'upstream[\\s_-]*capacity',
  'capacity[\\s_-]*(?:exhausted|unavailable|limit)',
  'cooling[\\s_-]*down',
  'circuit[\\s_-]*(?:open|upstream)',
  'overloaded',
  // HTTP and provider status codes.
  '\\b429\\b',
  'too[\\s_-]*many[\\s_-]*requests',
  'resource[\\s_-]*exhausted',
  'quota[\\s_-]*(?:exceeded|exhausted)',
  'rate[\\s_-]*limit(?:ed|_exceeded|s)?\\b',
  'server[\\s_-]*(?:is[\\s_-]*)?busy',
].join('|'), 'i')

// Hint patterns, tried in this order. Every separator is [_\s-]* so that the
// snake_case key form (`retry_after_ms`), the header form (`Retry-After`), and
// the prose form (`retry after 28 seconds`) all match the same way.
//
// Getting this wrong is SILENT: an unmatched hint does not error, it just means
// the plugin declines the failure and the built-in retry gives up as before.
// Hence the regression tests, which use the real gateway message verbatim.

/** `retry_after_ms`, `retry-after-ms`, `retry after 1500 ms`. */
const MS_HINT = /retry[_\s-]*after[_\s-]*(?:ms|msecs?|milliseconds?)\b["'\s:=]*(\d+)/i

/** `retry_after_seconds`, `retry-after-seconds`, `retry after 3.5 secs`. */
const SECONDS_HINT =
  /retry[_\s-]*after[_\s-]*(?:seconds?|secs?)\b["'\s:=]*(\d+(?:\.\d+)?)/i

/**
 * Prose that puts the number first: "please retry after 28 seconds",
 * "try again in 500 ms". Unit-aware, so it must be tried BEFORE `BARE_HINT` —
 * otherwise "...after 1500 ms" would be read as 1500 *seconds*.
 */
const PROSE_HINT =
  /(?:retry|try)(?:\s+again)?\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s)\b/i

/**
 * A bare `retry_after: 28` / `retry-after: 28` / `retry after 28` — seconds.
 * The separator also swallows a JSON quote (`"retry_after": 28`), which the
 * ordering above cannot turn into a unit-qualified match.
 */
const BARE_HINT = /retry[_\s-]*after["'\s:=]*(\d+(?:\.\d+)?)/i

function toMs(amount, unit) {
  const value = Number.parseFloat(amount)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return /^m/i.test(unit) ? Math.round(value) : Math.round(value * 1000)
}

/**
 * How long does the upstream want us to wait? Milliseconds, or `undefined` when
 * the failure carries no usable hint.
 *
 * Recognized in order: a numeric `providerRetryAfterMs` field, then an explicit
 * millisecond key, an explicit seconds key, unit-qualified prose, and finally a
 * bare `retry after N`.
 */
export function extractDelayMs(failure) {
  if (failure === undefined || failure === null) return undefined
  if (positiveNumber(failure.providerRetryAfterMs)) return failure.providerRetryAfterMs
  // Some adapters surface the parsed `Retry-After` header as a bare `retryAfter`
  // in seconds. Checked after the millisecond field, never before it.
  if (positiveNumber(failure.retryAfter) && failure.providerRetryAfterMs === undefined) {
    return Math.round(failure.retryAfter * 1000)
  }

  const text = typeof failure.message === 'string' ? failure.message : ''

  let match = MS_HINT.exec(text)
  if (match !== null) {
    const ms = Number.parseInt(match[1], 10)
    if (Number.isFinite(ms) && ms > 0) return ms
  }

  match = SECONDS_HINT.exec(text)
  if (match !== null) {
    const ms = toMs(match[1], 'seconds')
    if (ms !== undefined) return ms
  }

  match = PROSE_HINT.exec(text)
  if (match !== null) {
    const ms = toMs(match[1], match[2])
    if (ms !== undefined) return ms
  }

  match = BARE_HINT.exec(text)
  if (match !== null) {
    const ms = toMs(match[1], 'seconds')
    if (ms !== undefined) return ms
  }

  return undefined
}

/** Keep the upstream's request inside our own sane window. */
export function clampDelay(ms, options = DEFAULT_OPTIONS) {
  return Math.min(Math.max(ms, options.minDelayMs), options.maxDelayMs)
}

/**
 * The delay for one attempt. The upstream's own hint always wins; only a
 * hint-less capacity failure (which is opt-in via `hintlessBackoff`) falls back
 * to exponential growth, and that fallback is still clamped to the window.
 */
export function planDelay(attempt, hintMs, options = DEFAULT_OPTIONS) {
  if (hintMs !== undefined) return { delayMs: clampDelay(hintMs, options), source: 'hint' }
  const raw = options.hintlessBaseDelayMs * 2 ** Math.max(0, attempt - 1)
  return { delayMs: clampDelay(raw, options), source: 'backoff' }
}

/** `${turn}:${provider}` when counting across steps, `${turn}:${step}:${provider}` otherwise. */
export function counterKey(entry, options = DEFAULT_OPTIONS) {
  return options.acrossSteps === true
    ? entry.turn + ':' + entry.provider
    : entry.turn + ':' + entry.step + ':' + entry.provider
}

/**
 * Mutable per-process counters shared by the log lines and the `/cooldown-retry`
 * command. `session` resets on every mounted turn; `lifetime` never does.
 */
export function createStats() {
  const blank = () => ({
    waits: 0,
    giveUps: 0,
    skipped: 0,
    totalWaitMs: 0,
    byProvider: {},
    last: undefined,
  })
  const session = blank()
  const lifetime = blank()

  function record(bucket, entry) {
    bucket.waits += 1
    bucket.totalWaitMs += entry.waitMs
    bucket.byProvider[entry.provider] = (bucket.byProvider[entry.provider] ?? 0) + 1
    bucket.last = entry
  }

  return {
    session,
    lifetime,
    /** A retry we own: the wait is about to start. */
    plan(entry) {
      record(session, entry)
      record(lifetime, entry)
    },
    /** The budget is spent and this turn/provider is handed back downstream. */
    giveUp(entry) {
      session.giveUps += 1
      lifetime.giveUps += 1
      session.last = { ...entry, outcome: 'give-up' }
      lifetime.last = session.last
    },
    /** A capacity failure we declined because it carried no usable hint. */
    skip(entry) {
      session.skipped += 1
      lifetime.skipped += 1
      if (entry !== undefined) {
        session.last = { ...entry, outcome: 'skipped' }
        lifetime.last = session.last
      }
    },
    /** A new turn mounted: session counters restart, lifetime counters do not. */
    resetSession() {
      session.waits = 0
      session.giveUps = 0
      session.skipped = 0
      session.totalWaitMs = 0
      session.byProvider = {}
      session.last = undefined
    },
  }
}

/**
 * Human duration, unit included exactly once. The unit belongs to the number:
 * a caller that concatenates its own `'ms'` onto `formatWaits` output produces
 * `1.0sms`, so the split below keeps the formatter the only place a unit is
 * chosen.
 */
function formatDurations(totalMs) {
  if (totalMs < 1000) return { value: String(totalMs), unit: 'ms' }
  if (totalMs < 60000) return { value: (totalMs / 1000).toFixed(1), unit: 's' }
  return { value: String(Math.round(totalMs / 1000)), unit: 's' }
}

function formatWaits(totalMs) {
  const { value, unit } = formatDurations(totalMs)
  return value + unit
}

function formatBucket(bucket) {
  const providers = Object.entries(bucket.byProvider)
    .sort((a, b) => b[1] - a[1])
    .map(([provider, count]) => provider + '×' + count)
  //
  // `last` is read defensively: a live Agent or Signal must never leak into the
  // formatted string, only the plain fields this plugin itself recorded.
  const last = bucket.last
  const suffix = last === undefined
    ? ''
    : ' | last: ' + last.provider + ' ' + formatWaits(last.waitMs)
      + ' (' + last.attempt + '/' + last.maxRetries + ')'
      + (last.outcome === 'give-up' ? ' — budget spent' : '')
      + (last.outcome === 'skipped' ? ' — no hint' : '')
  return 'retries ' + bucket.waits
    + ' | waited ' + formatWaits(bucket.totalWaitMs)
    + ' | gave up ' + bucket.giveUps
    + ' | no-hint capacity failures ' + bucket.skipped
    + (providers.length > 0 ? ' | ' + providers.join(' ') : '')
    + suffix
}

/** Render the `/cooldown-retry` report. Pure: no reads of live Cordis objects. */
export function formatStats(stats, options = DEFAULT_OPTIONS) {
  return [
    'cooldown-retry — ' + (options.acrossSteps === true ? 'budget per turn' : 'budget per turn/step')
      + ', max ' + options.maxRetries + ' retries'
      + ', window ' + options.minDelayMs + '–' + options.maxDelayMs + 'ms'
      + (options.hintlessBackoff === true ? ', hint-less backoff on' : ''),
    'this turn: ' + formatBucket(stats.session),
    'lifetime:  ' + formatBucket(stats.lifetime),
  ].join('\n')
}

/**
 * Resolve the plugin's logger.
 *
 * `ctx.logger` is a Cordis service that is both callable and carries the
 * severity methods: `ctx.logger('name')` returns a named facade, while
 * `ctx.logger.info(...)` logs under the fiber-derived name. The factory form is
 * preferred so the lines are attributed to this plugin. This file is also driven
 * by a stub context in the tests, so a logger that is only a plain object — or
 * no logger at all — still works, falling back to the console.
 */
function loggerFor(ctx) {
  const service = ctx.logger
  const named = typeof service === 'function' ? service('cooldown-retry') : service
  if (named !== undefined && named !== null && typeof named.info === 'function') {
    return {
      info: (message) => named.info(message),
      warn: (message) => (typeof named.warn === 'function' ? named.warn(message) : named.info(message)),
    }
  }
  return {
    info: (message) => console.log('[cooldown-retry] ' + message),
    warn: (message) => console.warn('[cooldown-retry] ' + message),
  }
}

export function apply(ctx, config) {
  const options = resolveOptions(config)
  const { maxRetries } = options
  const log = loggerFor(ctx)
  const stats = createStats()
  /** Attempts already spent, per counter key. */
  const counters = new Map()
  let currentTurn

  /**
   * Sleep, but wake early (and report failure) when the turn is aborted — a
   * user cancelling must not leave a 5-minute timer holding the step open.
   */
  function cancellableDelay(ms, signal) {
    return new Promise((resolve) => {
      let settled = false
      function finish(ok) {
        if (settled) return
        settled = true
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        resolve(ok)
      }
      function onAbort() { finish(false) }
      if (signal !== undefined) {
        if (signal.aborted) { finish(false); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      ctx.timeout(ms).then(
        () => finish(true),
        () => finish(false),
      )
    })
  }

  /**
   * Start a new turn when the incoming failure belongs to one: every budget from
   * the previous turn is dropped, so the map cannot grow without bound across a
   * long session. Runs before anything is recorded, including the skip path, so
   * the session counters always reflect the turn the failure actually came from.
   */
  function beginTurn(turn) {
    if (turn === currentTurn) return
    currentTurn = turn
    counters.clear()
    stats.resetSession()
  }

  function attemptFor(entry) {
    const key = counterKey(entry, options)
    if (counters.size > 256) {
      for (const [staleKey, value] of counters) {
        if (value.turn !== entry.turn) counters.delete(staleKey)
      }
    }
    return { key, count: counters.get(key)?.count ?? 0 }
  }

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    const failure = payload.failure
    if (failure === undefined || failure === null) return next()
    if (!isCapacityFailure(failure)) return next()

    const hintMs = extractDelayMs(failure)
    const owner = {
      turn: payload.turn,
      step: payload.step,
      provider: payload.provider,
    }
    beginTurn(owner.turn)

    if (hintMs === undefined && options.hintlessBackoff !== true) {
      // A capacity cooldown with no usable hint is the noisy case worth
      // reporting: it is exactly the failure this plugin cannot act on.
      stats.skip({ ...owner, waitMs: 0, attempt: 0, maxRetries })
      log.info('capacity cooldown for ' + owner.provider
        + ' (turn ' + owner.turn + ' step ' + owner.step
        + ') carried no retry hint — delegating to the built-in retry')
      return next()
    }

    const { key, count } = attemptFor(owner)
    if (count >= maxRetries) {
      counters.delete(key)
      stats.giveUp({ ...owner, waitMs: 0, attempt: count, maxRetries })
      log.warn('giving up after ' + count + ' patient retries for ' + owner.provider
        + ' (turn ' + owner.turn + ' step ' + owner.step + ')')
      return next()
    }
    counters.set(key, { count: count + 1, turn: owner.turn })

    const attempt = count + 1
    const plan = planDelay(attempt, hintMs, options)
    const wait = plan.delayMs

    stats.plan({ ...owner, waitMs: wait, attempt, maxRetries, source: plan.source })
    log.info('upstream cooling down for ' + owner.provider
      + ' (turn ' + owner.turn + ' step ' + owner.step + '): retrying in ' + wait + 'ms'
      + ' (' + attempt + '/' + maxRetries + ')'
      + (plan.source === 'backoff' ? ' — no hint, exponential fallback' : ''))

    const { signal } = payload
    return (async () => {
      const ok = await cancellableDelay(wait, signal)
      if (!ok) return undefined
      return { kind: 'retry' }
    })()
  })

  /**
   * `/cooldown-retry` — the queryable half of the observability story. The
   * `commands` service is optional: absent (headless, ACP, a partial profile)
   * it simply means no command, never a plugin stuck in `waiting`.
   */
  const commands = ctx.get('commands')
  const disposeCommand = commands === undefined
    ? undefined
    : commands.register({
      name: 'cooldown-retry',
      description: 'Show cooldown-retry counters: patient retries, total wait, give-ups',
      handler: () => ({ kind: 'success', text: formatStats(stats, options) }),
    })

  ctx.effect(() => () => {
    disposeListener()
    if (disposeCommand !== undefined) disposeCommand()
    counters.clear()
  }, 'cooldown-retry: listener, command and counters')
}
