# dropenv

Share `.env` files and API keys without leaving them in chat history.
**Paste. Encrypt. Share. Burn.** Zero dependencies, Node 18+.

Encryption happens on your machine (AES-256-GCM). The relay only stores ciphertext, and the key lives in the link's `#fragment`, which is never sent to a server.

## Quick start

```sh
# 1. run a relay + web app (or use one your team hosts)
npx dropenv serve --port 8787

# 2. encrypt a file and get a one-time link
npx dropenv .env --ttl 1h
# -> http://localhost:8787/#d=AbCd...&key=...

# 3. the recipient decrypts (the link already says which relay to use)
npx dropenv pull "<link>" --out .env
```

The same link also opens in the browser, and drops made in the browser open in the CLI.

## Commands

| Command | What it does |
| --- | --- |
| `dropenv [push] [file\|-]` | Encrypt a file (default `.env`) or stdin. Prints the link to stdout, details to stderr. |
| `dropenv pull <link\|12 words>` | Decrypt to stdout, or `--out FILE` (mode 600, refuses to overwrite without `--force`). |
| `dropenv burn <link\|id>` | Destroy a drop now. |
| `dropenv serve [--port N]` | Run the relay and the web app. |

Push options: `--ttl 10m\|1h\|24h\|7d`, `--no-burn`, `--pw` (hidden prompt), `--phrase` (12-word BIP-39 phrase instead of a link).
Common: `--relay URL` / `DROPENV_RELAY`, `--site URL` / `DROPENV_SITE`, `DROPENV_PASSWORD`.

## Pipelines

```sh
cat .env | npx dropenv - --ttl 10m --relay https://drop.example.com | pbcopy
npx dropenv pull "<link>" > .env.local
```

## Security notes

- The relay keeps drops in RAM only; a restart wipes them. Run it behind HTTPS.
- Passwords are prompted, not taken as flags, so they stay out of shell history and process lists.
- `pull --out` writes the file before burning the drop, so a failed write never destroys the only copy.
- A password-protected drop is destroyed after 5 wrong attempts.
- Anyone holding the full link can open the drop. Send link and password through different channels.
- Not audited. Review the ~200 lines in `bin/dropenv.js` before trusting it with production secrets.

MIT
