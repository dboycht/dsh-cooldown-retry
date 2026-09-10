// Dynamic-half client code for dsh-cooldown-retry — the floating countdown badge.
//
// Usage: pass the BODY OF THIS FILE (not the file itself) as the `code.client`
// argument of a Cordis `cordis_define` call, with `dynamic/host.js` as
// `code.host`. See dynamic/README.md.
//
// Registers one entry in the `shell.overlay` slot and polls the host half's
// package-private `retry-status` method every 500ms, rendering nothing unless a
// retry is actually pending.

return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const disposeStyles = styles.insert(
      '.cooldown-retry-badge{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;'
      + 'display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;'
      + 'background:rgba(28,30,38,.92);color:#fff;font-size:13px;font-family:inherit;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.3);backdrop-filter:blur(8px);'
      + 'border:1px solid rgba(255,255,255,.14);pointer-events:none;user-select:none;'
      + 'animation:cooldown-retry-pulse 1.6s ease-in-out infinite}'
      + '.cooldown-retry-dot{width:8px;height:8px;border-radius:50%;background:#ffb454;'
      + 'box-shadow:0 0 8px #ffb454;flex:none}'
      + '@keyframes cooldown-retry-pulse{0%,100%{opacity:1}50%{opacity:.72}}'
    )

    function RetryBadge() {
      const stateArr = React.useState(null)
      const state = stateArr[0]
      const setState = stateArr[1]

      React.useEffect(function () {
        let alive = true
        const tick = function () {
          host.call('retry-status').then(function (s) {
            if (alive) setState(s)
          }).catch(function () { /* host not ready or plugin stopped */ })
        }
        tick()
        const dispose = ctx.interval(function () { tick() }, 500)
        return function () { alive = false; dispose() }
      }, [])

      if (state === null || state === undefined || state.retrying !== true) return null
      const secs = Math.max(0, Math.round((state.remainingMs || 0) / 1000))
      return React.createElement('div', { className: 'cooldown-retry-badge' },
        React.createElement('span', { className: 'cooldown-retry-dot' }),
        '上游冷却中，约 ' + secs + ' 秒后自动重试（第 ' + state.attempt + '/' + state.maxRetries + ' 次）'
      )
    }

    slots.inject('shell.overlay', function () {
      slots.register(
        { name: 'shell.overlay', id: 'cooldown-retry-status', order: 1000 },
        function () { return React.createElement(RetryBadge) }
      )
    })

    ctx.effect(function () { return function () { disposeStyles() } }, 'cooldown-retry client styles')
  },
}
