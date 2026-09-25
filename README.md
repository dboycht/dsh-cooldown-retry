# dsh-cooldown-retry

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)

> 中文文档 → **[README.zh.md](README.zh.md)**

**Patient auto-retry for DeepSeek Harness.** When an upstream model gateway answers with `429 Too Many Requests` plus a `retry_after_seconds` hint — *"All upstream providers are cooling down. Please retry after 28 seconds."* — this plugin waits the delay the upstream actually asked for and retries, instead of letting the built-in `llm-retry` burn two fast attempts (500 ms → ~1 s) inside a 28-second cooldown window and then fail the turn.

It also absorbs one specific gateway bug seen in the field: during saturation a shared gateway can answer an ordinary request with a `400` whose message says *"Audio modality is not supported"* — although the request contained no audio at all — cache that body in a **client-error circuit**, and then replay the same 400 for every later request in the window, failing turn after turn. Once that provider has shown a capacity cooldown moments earlier, this plugin treats such a body as circuit replay and waits it out, on its own separate budget.

## The problem

Shared LLM gateways (campus networks, self-hosted proxies, provider pools) frequently answer with a **capacity** 429 rather than a connectivity error: the pool is momentarily exhausted or its circuit breaker is open, and the response tells you exactly how long to wait.

DeepSeek Harness can already act on that hint — but only through a narrow path:

- `llm-retry` **does** honour `failure.providerRetryAfterMs` when the field is present (`packages/llm/llm-retry/src/index.ts`). It waits that long verbatim, up to `policy.maxDelayMs`, and delegates to the next listener above that cap.
- The field is populated by adapters that parse the HTTP `Retry-After` response header. `llm-deepseek` does.
- **`llm-pi-ai` does not parse it at all** — a full-package search finds no `retry-after` handling outside a single test fixture. Behind that adapter the field is *never* set.
- So when the only hint is the **prose inside the error body**, nothing in DSH reads it. `llm-retry` falls back to its local backoff (~500 ms → ~1 s, 2 attempts) and the turn dies inside a 28-second cooldown — even though waiting 28 seconds would have succeeded.

Reading the hint out of the message and then waiting as long as the upstream asked is the gap this plugin fills.

## What it does

|  | built-in `llm-retry` (no usable hint) | `dsh-cooldown-retry` |
|---|---|---|
| Attempts per turn/provider | 2 | 5 |
| Backoff | fixed ~500 ms → 1 s | the upstream's own `retry_after_seconds` |
| Delay window | — | clamped to 1 s … 300 s |
| Abort-aware | — | yes — a cancelled turn ends the wait immediately |
| Hints parsed | — | `providerRetryAfterMs`, `retryAfter`, `retry_after_seconds`, `retry_after_ms`, prose `retry after N` |

It takes over **only** two shapes of failure: a capacity cooldown that carries a retry hint, and — with `mislabeledClientError` (on by default) — a `400` that claims a modality "is not supported" **and** arrives within `mislabeledEvidenceMs` of a capacity cooldown on the same provider. Everything else is handed to the next listener with `next()`, so auth errors, network errors, hint-less 429s, and genuine client errors keep their built-in behavior.

The budget is counted **per turn and provider**, not per step: a multi-step turn that trips the same cooldown in every step shares one budget instead of getting a fresh five in each. A new turn resets it.

## Install

### As a DSH bundle (recommended)

```sh
dsh plugin --profile web add github:dboycht/dsh-cooldown-retry
```

`dsh plugin add` installs the package into the profile, registers the bundle layer declared by `dsh.bundle.patch`, and the row mounts on the next config reload — **no restart needed**. It is permanent by design and survives upgrades. (Under the hood it forwards to pnpm in the profile directory, so it needs `git` on `PATH` for a `github:` specifier — the same requirement DSH itself already has.)

**Verify** it mounted — ask DSH for the composed tree and look for the row:

```sh
dsh --profile web --dump-config | grep -A2 'cooldown-retry'
```

```yaml
# == dsh-cooldown-retry
- id: cooldown-retry
  name: dsh-cooldown-retry
```

Its position matters: the row must appear *after* the built-in `llm-retry` row. `agent/request-error` is a waterfall and later-registered listeners bind as inner listeners, so this plugin gets first refusal on each failure instead of being short-circuited by the built-in fast retry.

### Without installing a package

Point a row straight at the file. A **new row requires `insert`**, and `name` must be a `file:///` URL — see [Gotchas](#gotchas).

```yaml
- insert:
    - id: cooldown-retry
      name: "file:///absolute/path/to/dsh-cooldown-retry/index.js"
```

Put that in your home-level `$DSH_HOME/cordis.patch.yml` (every profile) or a profile's own `cordis.patch.yml` (one profile). Both layers are watched, so saving applies it live.

## Configure

Defaults are `maxRetries: 5`, `minDelayMs: 1000`, `maxDelayMs: 300000`, `acrossSteps: true`, `hintlessBackoff: false`, `hintlessBaseDelayMs: 5000`, `mislabeledClientError: true`, `mislabeledMaxRetries: 3`, `mislabeledBaseDelayMs: 15000`, `mislabeledEvidenceMs: 600000`. Override them from your own patch layer:

```yaml
- id: cooldown-retry
  config:
    maxRetries: 10
    maxDelayMs: 600000
```

A non-`insert` patch replaces the targeted row's **whole** `config`, so restate every key you want to keep. Unusable values are ignored in favour of the defaults, and an inverted window is repaired rather than accepted. `maxRetries` and `mislabeledMaxRetries` are capped at 100.

| Key | Meaning |
|---|---|
| `maxRetries` | Patient retries per turn/provider before handing the failure downstream. |
| `minDelayMs` / `maxDelayMs` | The window every wait is clamped into. |
| `acrossSteps` | `true` (default) shares one budget across the steps of a turn; `false` restores a budget per turn/step. |
| `hintlessBackoff` | Also take over a capacity cooldown that carries **no** hint, using `hintlessBaseDelayMs * 2^(attempt-1)`. Off by default: hint-less throttling is indistinguishable from a permanent capacity problem, so retrying it is a policy change, not a bug fix. |
| `hintlessBaseDelayMs` | The first hint-less backoff step. |
| `mislabeledClientError` | `true` (default) also waits out a `400` that claims a modality "is not supported" while the request carried no such thing — the client-error circuit a saturated gateway creates and then replays. Set `false` to let every `400` reach the caller untouched. |
| `mislabeledMaxRetries` | Retry budget for those replays, **separate** from `maxRetries`: waiting out a circuit must not compete with the 429 budget. |
| `mislabeledBaseDelayMs` | Base delay for a replay that carries no hint of its own (`retry_after_sec` in a circuit body is used verbatim when present). Doubles per attempt. |
| `mislabeledEvidenceMs` | How long a capacity cooldown keeps counting as evidence. Outside this window the same `400` is treated as a genuine client error and delegated. |

## Observability

Every wait and give-up goes through `ctx.logger` under the `cooldown-retry` name, so it shows up with the rest of the app's logs instead of a bare `console.log`:

```
[cooldown-retry] upstream cooling down for nuaa (turn 3 step 2): retrying in 28000ms (1/5)
```

### The countdown card in the UI

Each wait also writes a durable record **before** it starts and closes it when the wait finishes, matching the built-in `llm-retry` exactly:

| Record | When | Fields |
|---|---|---|
| `llm/retry` | before the wait | `retryId` `turn` `step` `provider` `policyKey` `retry` `maxRetries` `delayMs` `failure` |
| `llm/retry-started` | after a completed wait | `retryId` `turn` `step` `retry` |

The console's chat view therefore renders this wait through its own **model-retry card**: a live countdown plus the attempt number — *"retrying in about 30 s (1/5)"*. **That is what a patient wait looks like in the UI, with no client code at all.** An aborted wait leaves only the scheduled record, because that attempt never started.

The two policies own separate chains (`policyKey` `cooldown-retry/capacity` and `cooldown-retry/mislabeled`), and the numbering is derived from session history rather than an in-memory counter, so a plugin remount or a resumed session continues the chain instead of restarting at 1. `dsh-llm-retry`'s **own invariant** validates these records and rejects a malformed one; this repository pins the shape in `test/journal.test.js` and a contract-check script drives the real invariant.

In the composer, `/cooldown-retry` prints the counters:

```
cooldown-retry — budget per turn, max 5 retries, window 1000–300000ms, mislabeled-400 takeover on (max 3)
this turn: retries 3 | waited 84s | gave up 1 | no-hint capacity failures 2 | mislabeled 400 retries 1 | nuaa×4 | last: nuaa 15.0s (1/3) — mislabeled 400
lifetime:  retries 11 | waited 4m 12s | gave up 2 | no-hint capacity failures 7 | mislabeled 400 retries 3 | nuaa×10 deepseek×2
```

The command is registered only when the `commands` service is present. A context without it — headless, ACP, a partial profile — still mounts and still retries; only the command is missing. That is deliberate: making `commands` a hard `inject` dependency would park the whole plugin in `waiting` over a cosmetic command.

## Uninstall

```sh
dsh plugin --profile web remove dsh-cooldown-retry
```

Then drop the `- id: cooldown-retry` override from your patch layer if you added one.

## Optional: floating countdown badge

**The countdown is already a capability of the permanent row**: every wait writes an `llm/retry` record that the console renders as its model-retry card (see "The countdown card in the UI" above). What follows is therefore a cosmetic add-on.

[`dynamic/`](dynamic/) holds a two-half version for DSH's **dynamic Cordis plugin** path. It adds a small floating badge at the bottom of the window — *"cooling down, retrying in 23 s (1/5)"* — while a retry is pending.

It relies on `harness.handle` / `host.call`, which exist **only** for dynamic plugins, so it cannot be shipped as a bundle row and it is erased by a process restart. Treat it as a cosmetic add-on beside the permanent row, never as a replacement.

## Gotchas

Both of these fail **silently**. Read them before wiring up any DSH plugin row by file path.

### 1. A new row needs `insert`

A non-`insert` patch entry means *"override the row with this id"*. Writing `- id: cooldown-retry` together with `name:` is therefore read as an override of a row that does not exist: DSH prints `patch: entry "cooldown-retry" not found` to stderr and **skips it**. Your config looks correct, no error surfaces in the UI, and nothing is mounted.

```yaml
# ✗ silently does nothing
- id: cooldown-retry
  name: "file:///path/to/index.js"

# ✓
- insert:
    - id: cooldown-retry
      name: dsh-cooldown-retry
```

### 2. A file row's `name` must be a `file:///` URL

| `name` | Result |
|---|---|
| `D:/path/to/index.js` | ✗ `ERR_UNSUPPORTED_ESM_URL_SCHEME` — Node reads `D:` as a URL scheme |
| `./path/to/index.js` | ✗ resolved against the **profile directory**, not the patch file's directory |
| `file:///D:/path/to/index.js` | ✓ |

The loader treats only names starting with `.` as relative (against its `baseUrl`, which is the profile directory). Everything else goes through a bare `import()`, which on Windows accepts only a well-formed `file://` URL.

## How it works

`agent/request-error` is a **waterfall** event: listeners run outermost-first in registration order, and the first one that returns `{ kind: 'retry' }` *without* calling `next()` vetoes the rest of the chain, including the built-in behavior.

So running two copies — say the bundle row plus a dynamic plugin — does **not** double your retries. One of them owns each failure and the other is short-circuited. The registered-first copy wins.

## Development

```sh
git clone https://github.com/dboycht/dsh-cooldown-retry && cd dsh-cooldown-retry
npm test        # node --test — no dependencies, no build step needed
```

The suite lives in `test/`, which is **not** part of the published/installed package (the `files` whitelist ships only what a running DSH needs), so clone the repository rather than running this inside `node_modules`.

The retry-decision helpers — `extractDelayMs`, `isCapacityFailure`, `clampDelay`, `planDelay`, `counterKey`, `resolveOptions`, `createStats`, `formatStats` — are exported and unit-tested; `apply()` is thin Cordis wiring around them, and the suite drives it through a stub context so what it owns, what it delegates, and how it counts are all covered.

The stub context is a stand-in, not proof: `npm test` runs under `node --test`, which spawns a child process per file, so on a locked-down machine (or under a sandbox that forbids piped stdio) it can fail with `spawn EPERM` even though the suite is green. `node test/retry.test.js` runs the same tests in-process and is the fallback.

`inject` deliberately lists only `timer`. `commands` and `logger` are read through `ctx.get` / `ctx.logger` and degrade gracefully, and `ctx.logger` is used in its **callable** form — `ctx.logger('cooldown-retry')` — with a plain-object fallback, because Cordis's logger service is both callable and carries `.info`/`.warn` directly.

### Why the hint patterns look like that

The obvious pattern, `/retry-?after/`, matches `retry-after` and nothing else — **not** `retry_after` (underscore) and **not** `retry after` (space). An implementation built on it declines the very error it was written for, and it does so *silently*: an unmatched hint is not an error, the plugin just calls `next()` and the built-in retry gives up exactly as before.

So every separator here is `[_\s-]*`, the unit-qualified prose pattern runs **before** the bare one (otherwise `after 1500 ms` reads as 1500 *seconds*), and each case has a regression test built on the real gateway message.

## License

[MIT](LICENSE) © 2026 dboycht
