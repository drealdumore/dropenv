# dropenv

Share `.env` files and API keys without leaving them in chat history.
**Paste. Encrypt. Share. Burn.** Node 18+.

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
# From this package folder, install this local CLI version:
npm install -g .

dropenv config --relay https://YOUR-APP-URL
dropenv .env
```

After publishing this package to npm, users can install it with `npm install -g dropenv`
instead.

The command prints a link. Send it to the recipient. They can open it in a browser or
install the CLI and retrieve it directly in their terminal:

```sh
dropenv pull "https://YOUR-APP-URL/#d=...&key=..."
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

## Deploy on Pxxl

The relay needs persistent storage for drops to survive app restarts. When
`DATABASE_URL` is set, it uses PostgreSQL; without it, it uses local files (for local
development or a host with a persistent disk). The database stores ciphertext and
burn/expiry state, never decryption keys.

1. Push this repository to GitHub and connect it to Pxxl as a Node.js project.
2. Set the project root to `dropp/dropenv-1.0.0/package` (or the package folder if
   deploying a copy) so Pxxl finds this `package.json`.
3. Create a PostgreSQL database in Pxxl and add its connection string as the app's
   `DATABASE_URL` environment variable. Keep the URL private; never commit it.
4. Use `npm install` as the build command and `npm start` as the start command.
   The relay creates its table and index automatically on first start.
5. After deployment, check `https://YOUR-APP/api/health` returns JSON with
   `"dropenv":1`, then set the CLI default:

```sh
dropenv config --relay https://YOUR-APP
dropenv .env
```

The Pxxl guides describe managed PostgreSQL and Node.js hosting and say no credit card
is required, but confirm current plan quotas, persistence, backups, and pricing in your
dashboard before relying on the free tier. Enable TLS for the database connection if
Pxxl provides a TLS-enabled connection string.

For other hosts, set `DATABASE_URL` to a PostgreSQL connection string. If using local
file storage instead, set `DATA_DIR` to a persistent writable directory and terminate
public traffic over HTTPS at the hosting provider.

## Security notes

- The relay stores only ciphertext and burn markers; it never stores keys.
- Passwords are prompted, not taken as flags, so they stay out of shell history and process lists.
- `pull --out` writes the file before burning the drop, so a failed write never destroys the only copy.
- A password-protected drop is destroyed after 5 wrong attempts.
- Anyone holding the full link can open the drop. Send link and password through different channels.
- Not audited. Review the ~200 lines in `bin/dropenv.js` before trusting it with production secrets.

MIT
