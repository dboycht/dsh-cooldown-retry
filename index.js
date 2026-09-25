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
 * It also owns one deliberately narrow second case: a saturation-era gateway can
 * answer a perfectly ordinary request with an `invalid_request_error` 400 whose
 * message reads "modality is not supported", open a client-error circuit on it,
 * and then replay that same cached 400 for every later request in the window —
 * so a plain "继续" turn fails with an error the client cannot possibly fix.
 * That shape is retried only when the same provider showed a capacity cooldown
 * moments earlier (`mislabeledClientError`, on by default).
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
  /**
   * Take over the gateway's mislabeled client error: a 400 whose message is
   * "... modality is not supported" returned by a shared gateway that is cooling
   * down, cached in a client-error circuit, and then replayed for every later
   * request in the window. Guarded by `mislabeledEvidenceMs` — without a recent
   * capacity cooldown for the same provider it is a genuine client error and is
   * delegated untouched.
   */
  mislabeledClientError: true,
  /** Its own retry budget, separate from the 429 budget (`maxRetries`). */
  mislabeledMaxRetries: 3,
  /** Base delay for a replay with no hint of its own; doubles per attempt. */
  mislabeledBaseDelayMs: 15000,
  /** How long a capacity cooldown keeps counting as evidence for the above. */
  mislabeledEvidenceMs: 600000,
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
  options.mislabeledClientError = flag(source.mislabeledClientError, DEFAULT_OPTIONS.mislabeledClientError)
  if (positiveNumber(source.mislabeledMaxRetries)) {
    options.mislabeledMaxRetries = Math.min(Math.floor(source.mislabeledMaxRetries), MAX_RETRY_CEILING)
  }
  if (positiveNumber(source.mislabeledBaseDelayMs)) {
    options.mislabeledBaseDelayMs = Math.floor(source.mislabeledBaseDelayMs)
  }
  if (positiveNumber(source.mislabeledEvidenceMs)) {
    options.mislabeledEvidenceMs = Math.floor(source.mislabeledEvidenceMs)
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

/**
 * Is this the gateway's *mislabeled* client error — a 400 that says some
 * modality "is not supported" even though the request carried nothing of the
 * kind (verified: plain text, occasionally images, never audio)?
 *
 * This is the signature of a shared gateway that, after an upstream saturation
 * episode, answers with an `invalid_request_error` 400 (code 400001,
 * `source: "client"`), opens a client-error circuit on it, and replays the same
 * cached body for every later request until the circuit closes. It is
 * deliberately narrow: it must mention a modality, say it is not supported, AND
 * carry the 400 / invalid-request signal. A bare "modality is not supported"
 * without that envelope is not treated as this bug.
 */
export function isMislabeledModalityClientError(failure) {
  if (failure === undefined || failure === null) return false
  const message = typeof failure.message === 'string' ? failure.message : ''
  const code = typeof failure.code === 'string' ? failure.code : ''
  const text = message + ' ' + code
  if (!/modalit/i.test(text)) return false
  if (!/not[\s_-]*supported/i.test(text)) return false
  return /\b400\b/.test(message) || /invalid[_\s-]*request/i.test(text)
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

/**
 * The delay for one attempt at a mislabeled modality 400 (gateway circuit
 * replay). Its own hint — e.g. the `retry_after_sec` a circuit-open body can
 * carry — wins; otherwise the delay grows exponentially from
 * `mislabeledBaseDelayMs`. Kept separate from `planDelay` so the two policies
 * can be tuned and reported independently.
 */
export function planMislabeledDelay(attempt, hintMs, options = DEFAULT_OPTIONS) {
  if (hintMs !== undefined) return { delayMs: clampDelay(hintMs, options), source: 'hint' }
  const raw = options.mislabeledBaseDelayMs * 2 ** Math.max(0, attempt - 1)
  return { delayMs: clampDelay(raw, options), source: 'mislabeled-backoff' }
}

/**
 * Did the given provider show a capacity cooldown recently enough to count as
 * evidence that a following modality 400 is a circuit replay rather than a
 * genuine client error? `recordedAt` is the epoch ms of the last cooldown.
 */
export function isRecentSaturation(recordedAt, now, windowMs) {
  return typeof recordedAt === 'number' && now - recordedAt <= windowMs
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
    mislabeled: 0,
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
    if (entry.mislabeled === true) bucket.mislabeled += 1
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
      session.mislabeled = 0
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
      + (last.mislabeled === true ? ' — mislabeled 400' : '')
  return 'retries ' + bucket.waits
    + ' | waited ' + formatWaits(bucket.totalWaitMs)
    + ' | gave up ' + bucket.giveUps
    + ' | no-hint capacity failures ' + bucket.skipped
    + ' | mislabeled 400 retries ' + bucket.mislabeled
    + (providers.length > 0 ? ' | ' + providers.join(' ') : '')
    + suffix
}

/** Render the `/cooldown-retry` report. Pure: no reads of live Cordis objects. */
export function formatStats(stats, options = DEFAULT_OPTIONS) {
  return [
    'cooldown-retry — ' + (options.acrossSteps === true ? 'budget per turn' : 'budget per turn/step')
      + ', max ' + options.maxRetries + ' retries'
      + ', window ' + options.minDelayMs + '–' + options.maxDelayMs + 'ms'
      + (options.hintlessBackoff === true ? ', hint-less backoff on' : '')
      + (options.mislabeledClientError === true
        ? ', mislabeled-400 takeover on (max ' + options.mislabeledMaxRetries + ')'
        : ''),
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

/** Policy keys for the two durable retry chains this plugin journals. */
export const CAPACITY_POLICY_KEY = 'cooldown-retry/capacity'
export const MISLABELED_POLICY_KEY = 'cooldown-retry/mislabeled'

/**
 * Fallback failure codes. The durable boundary requires a non-empty `code`, and
 * a capacity failure can reach us with none (an adapter that minted only prose).
 */
const CAPACITY_FALLBACK_CODE = 'RATE_LIMIT'
const MISLABELED_FALLBACK_CODE = 'INVALID_REQUEST'

let retryIdSeq = 0

/**
 * Mint one retry-chain id. This package stays zero-import, so no `node:crypto`:
 * a process-local counter plus randomness is unique enough for a chain id that
 * only has to differ from every other chain in the same session.
 */
export function mintRetryId(now = Date.now(), random = Math.random()) {
  retryIdSeq += 1
  return 'cooldown-retry-' + now.toString(36) + '-' + retryIdSeq.toString(36)
    + '-' + random.toString(36).slice(2, 8)
}

/**
 * Rebuild a failure payload the durable boundary accepts.
 *
 * `llm/retry`'s own invariant requires non-empty `message` and `code`, and
 * rejects an out-of-range `status`, a non-positive `providerRetryAfterMs`, or a
 * non-string `requestId`. The raw failure comes from a provider adapter, so the
 * kept fields are copied one by one rather than spread: an unexpected extra key
 * is harmless, but a malformed known key would fail the append.
 */
export function sanitizeFailure(failure, fallbackCode) {
  const source = failure !== null && typeof failure === 'object' ? failure : {}
  const message = typeof source.message === 'string' && source.message.length > 0
    ? source.message
    : 'model request failed'
  const code = typeof source.code === 'string' && source.code.length > 0
    ? source.code
    : fallbackCode
  const clean = { message, code }
  if (Number.isInteger(source.status) && source.status >= 100 && source.status <= 599) {
    clean.status = source.status
  }
  if (Number.isFinite(source.providerRetryAfterMs) && source.providerRetryAfterMs > 0) {
    clean.providerRetryAfterMs = source.providerRetryAfterMs
  }
  if (typeof source.requestId === 'string' && source.requestId.length > 0) {
    clean.requestId = source.requestId
  }
  return clean
}

/**
 * The durable retry journal.
 *
 * A wait this plugin owns used to be invisible: the built-in `llm-retry`
 * appends `llm/retry` before its wait and `llm/retry-started` after it, and the
 * console's chat view renders those records as a `model-retry` card with a live
 * countdown (`Date.now() + delayMs`) and the attempt number. This plugin waits
 * just as patiently but wrote nothing, so the user saw a stall with no card.
 * Journalling the same two records under our own `policyKey` gives the card
 * without touching the console, and makes each wait auditable after the fact.
 *
 * The numbering follows the invariant, not our retry budget: `retry` must be
 * `1 +` the previous record for the same turn/step/provider/policyKey, and the
 * `retryId` must persist across that chain. Our budget counts per turn (with
 * `acrossSteps`), so a chain that spans steps restarts its display at 1 in each
 * new step — the invariant's rule, stated here because it is visible in the UI.
 */
export function createRetryJournal(onError) {
  const chains = new Map()
  const report = typeof onError === 'function' ? onError : () => {}

  /** Append one durable record, reporting rather than throwing on refusal. */
  function append(session, type, data) {
    try {
      session.append(type, data)
      return true
    } catch (error) {
      report(type + ' refused: ' + (error instanceof Error ? error.message : String(error)))
      return false
    }
  }

  /**
   * The prior record for this exact chain, read from durable history rather than
   * our map: a resumed session must continue the chain instead of restarting at
   * 1, and the invariant computes its expectation the same way.
   */
  function priorAttempt(session, entry, policyKey) {
    if (typeof session.snapshotEvents !== 'function') return undefined
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'llm/retry') continue
      if (event.data.turn !== entry.turn || event.data.step !== entry.step) continue
      if (event.data.provider !== entry.provider || event.data.policyKey !== policyKey) continue
      return event.data
    }
    return undefined
  }

  return {
    /** Drop every chain: budgets are per turn, and so are the chains. */
    clear() {
      chains.clear()
    },
    /**
     * Record a scheduled attempt BEFORE its wait, exactly as the built-in does.
     * @returns `{ retryId, retry }` to hand to `markStarted`, or undefined when
     * no session was reachable or the durable boundary refused the record.
     */
    schedule(session, entry, policyKey, delayMs, maxRetries, fallbackCode) {
      if (session === undefined || session === null || typeof session.append !== 'function') {
        return undefined
      }
      const key = entry.turn + ':' + entry.step + ':' + entry.provider + ':' + policyKey
      const cached = chains.get(key)
      let state
      if (cached !== undefined) {
        state = { retryId: cached.retryId, retry: cached.retry + 1 }
      } else {
        const prior = priorAttempt(session, entry, policyKey)
        state = prior === undefined
          ? { retryId: mintRetryId(), retry: 1 }
          : { retryId: prior.retryId, retry: prior.retry + 1 }
      }
      chains.set(key, state)
      const data = {
        retryId: state.retryId,
        turn: entry.turn,
        step: entry.step,
        provider: entry.provider,
        mode: 'normal',
        policyKey,
        retry: state.retry,
        maxRetries,
        delayMs,
        failure: sanitizeFailure(entry.failure, fallbackCode),
      }
      if (!append(session, 'llm/retry', data)) {
        chains.delete(key)
        return undefined
      }
      return { retryId: state.retryId, retry: state.retry }
    },
    /** Close the wait: pair the scheduled attempt, so the card stops counting. */
    markStarted(session, chain, entry) {
      if (session === undefined || session === null || typeof session.append !== 'function') return
      append(session, 'llm/retry-started', {
        retryId: chain.retryId,
        turn: entry.turn,
        step: entry.step,
        retry: chain.retry,
      })
    },
  }
}

/** The durable session behind one recovery payload, when the emitter supplied it. */
function sessionOf(payload) {
  const agent = payload.agent
  if (agent === undefined || agent === null) return undefined
  return agent.session
}

export function apply(ctx, config) {
  const options = resolveOptions(config)
  const { maxRetries } = options
  const log = loggerFor(ctx)
  const stats = createStats()
  /** Durable retry records, so the console renders a countdown card for each wait. */
  const journal = createRetryJournal((message) => log.warn('llm/retry journal: ' + message))
  /** Attempts already spent, per counter key. */
  const counters = new Map()
  /** Last capacity-cooldown timestamp per provider, for the mislabeled-400 gate. */
  const saturatedAt = new Map()
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
   * The shared tail of both policies: wait, then claim the retry. An aborted
   * turn resolves `undefined`, which the waterfall treats as "no action".
   * `afterWait` closes the durable record only when the wait actually finished —
   * an aborted wait never started the attempt, so it must stay unpaired.
   */
  function waitAndRetry(payload, wait, afterWait) {
    const { signal } = payload
    return (async () => {
      const ok = await cancellableDelay(wait, signal)
      if (!ok) return undefined
      if (afterWait !== undefined) afterWait()
      return { kind: 'retry' }
    })()
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
    journal.clear()
    stats.resetSession()
  }

  function attemptFor(entry, key = counterKey(entry, options)) {
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

    const capacity = isCapacityFailure(failure)
    const mislabeled = capacity !== true
      && options.mislabeledClientError === true
      && isMislabeledModalityClientError(failure)
    if (capacity !== true && mislabeled !== true) return next()

    const owner = {
      turn: payload.turn,
      step: payload.step,
      provider: payload.provider,
    }
    beginTurn(owner.turn)
    const hintMs = extractDelayMs(failure)

    // The two policies keep separate budgets: burning the 429 budget must not
    // stop the plugin from waiting out a circuit that replays the bogus 400.
    return capacity === true
      ? handleCapacity(payload, next, owner, hintMs)
      : handleMislabeled(payload, next, owner, hintMs)
  })

  /**
   * A capacity cooldown: wait as long as the upstream asked (or back off if
   * `hintlessBackoff` opted in), within this turn/provider's own budget.
   */
  function handleCapacity(payload, next, owner, hintMs) {
    // Remember that this provider was saturated. A mislabeled modality 400
    // arriving moments later is the gateway's circuit replaying this episode,
    // not a real complaint about the request that carries it.
    saturatedAt.set(owner.provider, Date.now())

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

    const session = sessionOf(payload)
    const chain = journal.schedule(
      session,
      { ...owner, failure: payload.failure },
      CAPACITY_POLICY_KEY,
      wait,
      maxRetries,
      CAPACITY_FALLBACK_CODE,
    )
    return waitAndRetry(payload, wait, chain === undefined
      ? undefined
      : () => journal.markStarted(session, chain, owner))
  }

  /**
   * The gateway's mislabeled client error. Only reachable after a recent
   * capacity cooldown on the same provider: the body says a modality "is not
   * supported" while the request carried nothing of the kind, which is the
   * signature of a client-error circuit created during saturation and replayed
   * for every later request. A modality 400 with no such evidence is a genuine
   * client error and is delegated untouched.
   */
  function handleMislabeled(payload, next, owner, hintMs) {
    if (!isRecentSaturation(saturatedAt.get(owner.provider), Date.now(), options.mislabeledEvidenceMs)) {
      log.info('"modality is not supported" 400 for ' + owner.provider
        + ' (turn ' + owner.turn + ' step ' + owner.step
        + ') with no recent capacity cooldown — treating it as a real client error')
      return next()
    }

    const key = counterKey(owner, options) + ':modality-400'
    const { count } = attemptFor(owner, key)
    if (count >= options.mislabeledMaxRetries) {
      counters.delete(key)
      stats.giveUp({
        ...owner,
        waitMs: 0,
        attempt: count,
        maxRetries: options.mislabeledMaxRetries,
        mislabeled: true,
      })
      log.warn('giving up after ' + count + ' mislabeled-400 retries for ' + owner.provider
        + ' (turn ' + owner.turn + ' step ' + owner.step + ')')
      return next()
    }
    counters.set(key, { count: count + 1, turn: owner.turn })

    const attempt = count + 1
    const plan = planMislabeledDelay(attempt, hintMs, options)
    stats.plan({
      ...owner,
      waitMs: plan.delayMs,
      attempt,
      maxRetries: options.mislabeledMaxRetries,
      source: plan.source,
      mislabeled: true,
    })
    log.info('"modality is not supported" 400 for ' + owner.provider
      + ' (turn ' + owner.turn + ' step ' + owner.step + ') after a recent cooldown'
      + ' — treating it as circuit replay, retrying in ' + plan.delayMs + 'ms'
      + ' (' + attempt + '/' + options.mislabeledMaxRetries + ')')

    const session = sessionOf(payload)
    const chain = journal.schedule(
      session,
      { ...owner, failure: payload.failure },
      MISLABELED_POLICY_KEY,
      plan.delayMs,
      options.mislabeledMaxRetries,
      MISLABELED_FALLBACK_CODE,
    )
    return waitAndRetry(payload, plan.delayMs, chain === undefined
      ? undefined
      : () => journal.markStarted(session, chain, owner))
  }

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
