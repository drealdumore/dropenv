# dropenv

Share `.env` files and API keys without leaving them in chat history.
**Paste. Encrypt. Share. Burn.** Zero dependencies, Node 18+.

Encryption happens on your machine (AES-256-GCM). The relay only stores ciphertext, and the key lives in the link's `#fragment`, which is never sent to a server.

## Quick start

```sh
# 1. run a relay + web app locally (or use one your team hosts)
npx dropenv serve --port 8787

# 2. point the CLI to that relay (one time)
dropenv config --relay http://localhost:8787

# 3. encrypt a file and get a one-time link
npx dropenv .env --ttl 1h
# -> http://localhost:8787/#d=AbCd...&key=...

# 4. the recipient decrypts (the link already says which relay to use)
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
Common: `--relay URL` / saved default / `DROPENV_RELAY`, `--site URL` / `DROPENV_SITE`, `DROPENV_PASSWORD`.

## Terminal-only sharing

Configure the hosted relay once after deploying it, then create a drop without opening
the website:

```sh
# From the npm package folder, install this local CLI version:
npm install -g .

dropenv config --relay https://your-app.onrender.com
dropenv .env
```

After publishing this package to npm, users can install it with `npm install -g dropenv`
instead.

The command prints a link. Send it to the recipient. They can open it in a browser or
install the CLI and retrieve it directly in their terminal:

```sh
dropenv pull "https://your-app.onrender.com/#d=...&key=..."
```

The CLI infers the relay from a full link. It prints the decrypted text to stdout and
burns the drop after successful retrieval unless it was created with `--no-burn`.
Alternatively, use `--out .env` to save the secret to a file. Opening a burn-on-read
drop in the browser first consumes it, so the recipient should choose one method and
open it only once. `dropenv config` shows the configured relay and
`dropenv config --clear` removes the saved default.

## Pipelines

```sh
cat .env | npx dropenv - --ttl 10m --relay https://drop.example.com | pbcopy
npx dropenv pull "<link>" > .env.local
```

## Deploy on Render

This app needs a relay for sharing drops between browsers or devices. The browser-only
fallback is local to one browser and is not a hosted relay. The relay stores encrypted
ciphertext only; encryption keys remain in the URL fragment and are not sent to it.

The repository's `render.yaml` creates a Node web service for this package, serves the
browser app, and mounts a persistent disk at `/var/data`. Deploy the repository through
Render's Blueprint flow and keep the disk mounted at `/var/data`. The service uses a
single instance because local persistent disks cannot be shared between instances.
Persistent disks require a paid Render web service plan; without one, drops are only
kept in the instance's temporary filesystem and can disappear on restart or deploy.

Render sets `PORT` automatically. For another host, run `node relay/server.js` and set
`DATA_DIR` to a persistent writable directory. Do not expose the relay over plain HTTP
on a public network; terminate HTTPS at the hosting provider.

## Security notes

- The relay persists ciphertext and burn markers to disk; it never stores keys.
- Passwords are prompted, not taken as flags, so they stay out of shell history and process lists.
- `pull --out` writes the file before burning the drop, so a failed write never destroys the only copy.
- A password-protected drop is destroyed after 5 wrong attempts.
- Anyone holding the full link can open the drop. Send link and password through different channels.
- Not audited. Review the ~200 lines in `bin/dropenv.js` before trusting it with production secrets.

MIT
