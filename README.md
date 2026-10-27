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

## Configuration

By default, the extension handles only the `my_model_hub` provider using Pi's `openai-responses` API. To opt in other provider names, set `PI_REASONING_RECOVERY_PROVIDERS` to a comma-separated list **before** starting Pi:

```sh
PI_REASONING_RECOVERY_PROVIDERS=my_model_hub,other_gateway pi --session SESSION_ID
```

The extension activates only when the current session contains an assistant error with `invalid_encrypted_content` and an `rs_...` item ID for the selected provider. Subsequent model requests omit encrypted reasoning blocks from that provider's assistant history, but retain text and tool calls. This affects only the request context: it never edits session files or decrypts/replaces encrypted content.

This does not retry the failed request automatically. Continue the session or send another prompt after installing and restarting Pi. Dropping old reasoning may reduce continuity; it cannot fix server-side key or routing problems, nor guarantee that other malformed requests succeed.

## Development

```sh
npm test
npm pack --dry-run
```
