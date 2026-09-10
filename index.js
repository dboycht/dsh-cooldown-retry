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
 */

export const name = 'cooldown-retry'

/** The timer mixin (`ctx.timeout` / `ctx.interval`) is a hard dependency. */
export const inject = ['timer']

/** Defaults. Override per row with `config: { maxRetries, minDelayMs, maxDelayMs }`. */
export const DEFAULT_OPTIONS = Object.freeze({
  maxRetries: 5,
  minDelayMs: 1000,
  maxDelayMs: 300000,
})

const CAPACITY_PATTERN =
  /upstream[\s_-]*capacity|cooling[\s_-]*down|circuit[\s_-]*upstream|capacity[\s_-]*exhausted/i

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Merge a row's `config` over the defaults, ignoring unusable values. */
export function resolveOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const options = { ...DEFAULT_OPTIONS }
  if (positiveNumber(source.maxRetries)) options.maxRetries = Math.floor(source.maxRetries)
  if (positiveNumber(source.minDelayMs)) options.minDelayMs = Math.floor(source.minDelayMs)
  if (positiveNumber(source.maxDelayMs)) options.maxDelayMs = Math.floor(source.maxDelayMs)
  // An inverted window would make clamp() return maxDelayMs forever; keep it sane.
  if (options.maxDelayMs < options.minDelayMs) options.maxDelayMs = options.minDelayMs
  return options
}

/**
 * Does this failure look like "the upstream pool is out of capacity"?
 * Matched case-insensitively against `message` + `code`.
 */
export function isCapacityFailure(failure) {
  if (failure === undefined || failure === null) return false
  const text = (typeof failure.message === 'string' ? failure.message : '')
    + ' ' + (typeof failure.code === 'string' ? failure.code : '')
  return CAPACITY_PATTERN.test(text)
}

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

/** A bare `retry_after: 28` / `retry-after: 28` / `retry after 28` — seconds. */
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

export function apply(ctx, config) {
  const { maxRetries, minDelayMs, maxDelayMs } = resolveOptions(config)
  /** Attempts already spent, per `${turn}:${step}:${provider}`. */
  const counters = new Map()

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

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    const failure = payload.failure
    if (failure === undefined || failure === null) return next()
    if (!isCapacityFailure(failure)) return next()

    const delayMs = extractDelayMs(failure)
    if (delayMs === undefined) return next()

    const { turn, step, provider, signal } = payload
    const key = turn + ':' + step + ':' + provider
    const count = counters.get(key) ?? 0

    if (count >= maxRetries) {
      counters.delete(key)
      console.log(`[cooldown-retry] giving up after ${count} patient retries for ${provider} (turn ${turn} step ${step})`)
      return next()
    }
    counters.set(key, count + 1)

    const wait = clampDelay(delayMs, { minDelayMs, maxDelayMs })
    const attempt = count + 1
    console.log(`[cooldown-retry] upstream cooling down for ${provider} (turn ${turn} step ${step}): retrying in ${wait}ms (${attempt}/${maxRetries})`)

    return (async () => {
      const ok = await cancellableDelay(wait, signal)
      if (!ok) return undefined
      return { kind: 'retry' }
    })()
  })

  ctx.effect(() => () => {
    disposeListener()
    counters.clear()
  }, 'cooldown-retry: listener and counters')
}
