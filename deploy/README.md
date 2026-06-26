# Countdown Worker

Cloudflare Worker that commits `countdown.json` to `bmottershead/bmottershead.github.io`
on behalf of a **GitHub App**. The GitHub Pages site POSTs the timestamps here; the
Worker mints a short-lived, repo-scoped installation token and does the commit.
No credentials ever reach the browser.

```
browser (Pages)  --POST {countdown:[...]}-->  Worker  --GitHub App token-->  Contents API
```

## 1. Register the GitHub App

GitHub → Settings → Developer settings → **GitHub Apps** → **New GitHub App**.

- **Name:** anything (e.g. `countdown-committer`)
- **Homepage URL:** `https://bmottershead.github.io`
- **Webhook:** uncheck **Active** (not needed)
- **Repository permissions:** **Contents → Read and write** (leave everything else "No access")
- **Where can this app be installed?** Only on this account

Create it, then note the **App ID** (shown on the app's General page).

## 2. Generate + convert the private key

On the app's page: **Private keys → Generate a private key**. This downloads a
PKCS#1 PEM (`-----BEGIN RSA PRIVATE KEY-----`). WebCrypto in the Worker needs
**PKCS#8**, so convert it:

```sh
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in your-app.YYYY-MM-DD.private-key.pem \
  -out private-key-pkcs8.pem
```

(`private-key-pkcs8.pem` starts with `-----BEGIN PRIVATE KEY-----`.)

## 3. Install the App on the repo

App page → **Install App** → install on your account → **Only select repositories**
→ choose `bmottershead.github.io`.

## 4. Configure + deploy the Worker

```sh
cd bmottershead.github.io/deploy

# Put the App ID into wrangler.toml (GITHUB_APP_ID = "...").

# Store the private key as a secret (multi-line value read from the file):
wrangler secret put GITHUB_APP_PRIVATE_KEY < private-key-pkcs8.pem

wrangler deploy
```

This deploys to `https://countdown.riverscape.workers.dev`.
(If you reuse an existing Worker name, change `name` in `wrangler.toml`.)

## 5. Point the site at the Worker

In `bmottershead.github.io/index.html`, set:

```js
const WORKER_URL = "https://countdown.riverscape.workers.dev";
```

Commit + push `index.html`. Done — count down to zero and the Worker commits
`countdown.json`.

## Test the Worker directly

```sh
curl -i -X POST https://countdown.riverscape.workers.dev \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://bmottershead.github.io' \
  -d '{"countdown":["2026-06-26T12:00:00.000Z","2026-06-26T12:00:01.000Z"]}'
```

Expect `{"ok":true,"commit":"...","file":"..."}` and a new commit on the repo.

## Notes / hardening

- Delete the private key file once the secret is set: `rm private-key-pkcs8.pem`.
- The Worker only ever writes one fixed path with fixed-shape data, and CORS is
  restricted to the listed origins. CORS is **not** a real auth boundary (curl
  ignores it), so anyone who finds the URL could append timestamps. For a public
  demo that's low-stakes; to lock it down add Cloudflare Turnstile, a rate limit,
  or a signed-request check.
- The installation token is created per request, scoped to `contents:write` on the
  single repo, and expires in ~1 hour.
