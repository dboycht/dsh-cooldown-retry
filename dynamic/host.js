// Dynamic-half host code for dsh-cooldown-retry — the badge variant.
//
// Usage: pass the BODY OF THIS FILE (not the file itself) as the `code.host`
// argument of a Cordis `cordis_define` call, with `dynamic/client.js` as
// `code.client`. See dynamic/README.md.
//
// Why it cannot ship as a bundle row: it calls `harness.handle`, one of the
// builtins that exist only inside the dynamic-plugin evaluator. A permanent
// composition row must use the package root (`index.js`) instead.
//
// This file is intentionally kept byte-faithful to the version that was verified
// working in a live session; it does not read `config` the way index.js does.

return {
  inject: ['timer'],
  apply(ctx) {
    const MAX_RETRIES = 5
    const MIN_DELAY_MS = 1000
    const MAX_DELAY_MS = 300000
    const counters = new Map()
    let retryState = null

    function keyOf(turn, step, provider) {
      return turn + ':' + step + ':' + provider
    }

    function extractDelayMs(failure) {
      if (failure.providerRetryAfterMs !== undefined
        && Number.isFinite(failure.providerRetryAfterMs)
        && failure.providerRetryAfterMs > 0) {
        return failure.providerRetryAfterMs
      }
      const text = typeof failure.message === 'string' ? failure.message : ''
      let m = /retry_after_seconds["'\s:=]*(\d+(?:\.\d+)?)/i.exec(text)
      if (m !== null) {
        const s = parseFloat(m[1])
        if (Number.isFinite(s) && s > 0) return Math.round(s * 1000)
      }
      m = /retry_after_ms["'\s:=]*(\d+)/i.exec(text)
      if (m !== null) {
        const ms = parseInt(m[1], 10)
        if (Number.isFinite(ms) && ms > 0) return ms
      }
      m = /retry-?after["'\s:=]*(\d+)/i.exec(text)
      if (m !== null) {
        const s = parseInt(m[1], 10)
        if (Number.isFinite(s) && s > 0) return s * 1000
      }
      return undefined
    }

    function isCapacityFailure(failure) {
      if (failure === undefined || failure === null) return false
      const text = (typeof failure.message === 'string' ? failure.message : '')
        + ' ' + (typeof failure.code === 'string' ? failure.code : '')
      return /upstream[\s_-]*capacity|cooling[\s_-]*down|circuit[\s_-]*upstream|capacity[\s_-]*exhausted/i.test(text)
    }

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

    // Polled by the client half every 500ms to drive the countdown badge.
    harness.handle('retry-status', () => {
      if (retryState === null) return { retrying: false }
      const now = Date.now()
      const remaining = Math.max(0, retryState.startedAt + retryState.waitMs - now)
      return {
        retrying: true,
        provider: retryState.provider,
        attempt: retryState.attempt,
        maxRetries: retryState.maxRetries,
        waitMs: retryState.waitMs,
        remainingMs: remaining,
      }
    })

    const disposeListener = ctx.on('agent/request-error', (payload, next) => {
      const failure = payload.failure
      if (failure === undefined || failure === null) return next()
      if (!isCapacityFailure(failure)) return next()

      const delayMs = extractDelayMs(failure)
      if (delayMs === undefined) return next()

      const turn = payload.turn
      const step = payload.step
      const provider = payload.provider
      const signal = payload.signal

      const key = keyOf(turn, step, provider)
      const count = counters.get(key) || 0
      if (count >= MAX_RETRIES) {
        counters.delete(key)
        console.log('[cooldown-retry] giving up after ' + count + ' patient retries for ' + provider + ' turn ' + turn + ' step ' + step)
        return next()
      }
      counters.set(key, count + 1)

      const wait = Math.min(Math.max(delayMs, MIN_DELAY_MS), MAX_DELAY_MS)
      const attempt = count + 1
      console.log('[cooldown-retry] upstream cooling down for ' + provider + ' (turn ' + turn + ' step ' + step + '): retrying in ' + wait + 'ms (' + attempt + '/' + MAX_RETRIES + ')')

      return (async () => {
        retryState = {
          retrying: true,
          provider: provider,
          attempt: attempt,
          maxRetries: MAX_RETRIES,
          waitMs: wait,
          startedAt: Date.now(),
        }
        try {
          const ok = await cancellableDelay(wait, signal)
          if (!ok) return undefined
          return { kind: 'retry' }
        } finally {
          retryState = null
        }
      })()
    })

    ctx.effect(() => () => {
      disposeListener()
      counters.clear()
      retryState = null
    }, 'cooldown-retry: listener, counters, state')
  },
}
