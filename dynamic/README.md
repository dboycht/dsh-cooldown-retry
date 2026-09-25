# Optional: the floating countdown badge

**Superseded for visibility.** The permanent package root now journals every wait as the built-in's own `llm/retry` + `llm/retry-started` records, so the console renders a model-retry card with a live countdown and the attempt number on its own (see "The countdown card in the UI" in the main README). The badge below is a second, optional way to show the same thing — and it only appears while *it* owns the wait, see the last section.

This folder is an **add-on**, not an alternative to the package root. It shows a small pill at the bottom of the window while a retry is pending:

> ● 上游冷却中，约 23 秒后自动重试（第 1/5 次）

## Why it lives here instead of in `cordis.patch.yml`

The badge needs two things that exist **only** for dynamic Cordis plugins:

- `harness.handle` — the host half publishes a package-private `retry-status` method;
- `host.call` — the client half polls it from the browser every 500 ms.

Neither builtin is available to a permanent composition row. (The permanent row does not need them for a countdown: its durable `llm/retry` records are what the console's own card renders.)

A dynamic plugin is also **process-local**: it is gone after a restart. Use it beside the permanent row, never instead of it.

## Installing it

Run a `cordis_define` with:

| argument | value |
|---|---|
| `plugin` | `{ "kind": "new", "idPrefix": "retry" }` |
| `name` | `Upstream Cooldown Auto-Retry` |
| `purpose` | whatever you like; describe the badge |
| `code.host` | the **body** of `host.js` — the file content minus nothing, i.e. starting at `return {` |
| `code.client` | the **body** of `client.js` |

Then `cordis_run` the returned `pluginId` / `packageId` with mode `run`. Because it carries client code, the first activation returns `awaiting-approval` — approve it in the UI. A successful run reports `state: running` with `client.status: running` and `handlers: ["retry-status"]`.

Both files are function bodies, not modules: they are evaluated by the dynamic-plugin sandbox, so they contain `return { ... }` at top level and use plain JavaScript only (no `import`, no JSX, no TypeScript).

## Living beside the permanent row

`agent/request-error` is a **waterfall**: the first listener that returns `{ kind: 'retry' }` without calling `next()` vetoes the rest of the chain. Whichever copy registered first handles each failure, so the two do not multiply retries.

In practice the dynamic copy usually registers later than the bundle row, so it is the *inner* listener and stays short-circuited — the badge appears only while **it** is the one handling the wait. If you want a dependable badge, install the dynamic half first, or accept that the badge is best-effort.
