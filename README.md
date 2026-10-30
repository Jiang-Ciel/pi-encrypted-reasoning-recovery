# Pi encrypted reasoning recovery

A small Pi extension for sessions that fail with `invalid_encrypted_content` when an OpenAI Responses-compatible gateway cannot verify an old `reasoning.encrypted_content` item.

## Install

Install from GitHub now:

```sh
pi install git:github.com/Jiang-Ciel/pi-encrypted-reasoning-recovery
```

The npm package is prepared but awaits its first registry publish. After it is published, this command will also work:

```sh
pi install npm:pi-encrypted-reasoning-recovery
```

Restart Pi after installation. If you already have a manually installed copy of this extension in `~/.pi/agent/extensions/`, remove or disable it before installing this package to avoid two context handlers running together. Check installation with `pi list`.

## TPM / quota interval recovery

On Pi 1.4.0+, this extension also retries TPM, PTU throughput, rate-limit,
`insufficient_quota`, and quota-exhaustion errors in the **same session**.
It runs after Pi's built-in recovery declines or exhausts its retries.

- Default: wait **60 seconds**, up to **5 extension retries per user turn**.
- `PI_LIMIT_RETRY_INTERVAL_MS=120000` changes the fixed interval to 2 minutes.
- `PI_LIMIT_RETRY_MAX_RETRIES=0` disables this recovery; valid range is 0–100.
- `PI_REASONING_RECOVERY_PROVIDERS` scopes both recoveries (default `my_model_hub`).
- Waiting uses the active provider AbortSignal: Escape / RPC abort cancels it.
- Successful conversation and tool results are retained; only the failed assistant
  attempt is omitted from model context using a durable context edit. Retry
  counters are session custom entries, not extra instructions sent to the model.
- Failed attempts containing tool calls are not retried by this extension, to
  avoid discarding tool results or duplicating executed work.
- Billing, payment, balance, and authentication failures are excluded. A real
  hard quota will not recover merely by waiting; retries stop at the configured
  bound. Pi's own/provider retries can add attempts between extension retries.

Reload Pi with `/reload` after updating. Environment changes require launching
Pi with the new variables. No session reset or context compaction is required.

## Configuration

By default, the extension handles only the `my_model_hub` provider using Pi's `openai-responses` API. To opt in other provider names, set `PI_REASONING_RECOVERY_PROVIDERS` to a comma-separated list **before** starting Pi:

```sh
PI_REASONING_RECOVERY_PROVIDERS=my_model_hub,other_gateway pi --session SESSION_ID
```

The extension activates when the current branch has an assistant error reporting an `rs_...` encrypted item for the selected provider (including errors whose gateway wrapper omits `invalid_encrypted_content`). Subsequent model requests omit encrypted reasoning blocks from that provider's assistant history, but retain text and tool calls. The branch check also works when compaction hides the error from request context. This affects only the request context: it never edits session files or decrypts/replaces encrypted content.

After an eligible failed run settles, the extension attempts **one** automatic continuation. It will not retry indefinitely; if the gateway rejects the new request too, a provider-side key or routing problem may need investigation. Reload an already-running Pi with `/reload` after updating the extension; a full restart is not required just to load the new code. Dropping old reasoning may reduce continuity and does not guarantee that other malformed requests succeed.

## Development

```sh
npm test
npm pack --dry-run
```
