# Countdown Worker (`deploy/`)

Cloudflare Worker that backs the tally-counter demo. It handles **"Login with
GitHub"** and commits `most-recent-timestamps.json` to this repo on behalf of a
**GitHub App**. The Pages site sends the timestamps here with a session token; the Worker
verifies the session, then mints a short-lived, repo-scoped installation token
and does the commit. **No credentials ever reach the browser.**

```
                       sign in
browser (Pages) ──GET /auth/login──▶ Worker ──▶ GitHub OAuth ──▶ Worker
      ▲                                                            │ mints session JWT
      └──────────────── #session=<jwt> ───────────────────────────┘

browser ──POST {timestamps:[…]} + Bearer <jwt>──▶ Worker ──App token──▶ Contents API
                                                   (gated on ALLOWED_LOGINS)
```

This directory is **excluded from the published site** (`deploy` is in the
repo's `_config.yml` Jekyll `exclude`), so the Worker source isn't served.

## Where things live

| Path | Role |
|------|------|
| `src/index.js` | The Worker: auth routes + gated commit. |
| `wrangler.toml` | Non-secret config (`[vars]`). |
| `bootstrap/` | One-command setup that creates the GitHub App + deploys (see `bootstrap/README.md`). |
| `../index.html`, `../tally.js`, `../style.css` | The site frontend (sign-in UI + count/save/history). |
| `../.github/workflows/append-log.yml` | Action that appends each commit to `timestamps.json`. |

## Routes

| Method + path | Purpose |
|---|---|
| `GET /auth/login` | Redirect to GitHub's OAuth authorize page. |
| `GET /auth/callback` | Exchange the code, mint a session JWT, redirect to `SITE_URL/#session=…`. |
| `GET /auth/me` | Return the signed-in user (`Authorization: Bearer <jwt>`) or 401. |
| `POST /` | Commit `most-recent-timestamps.json`. Requires a valid session whose login is allowed. |

## Setup

### Recommended: the bootstrap script

Creates the GitHub App from a manifest, uploads all secrets, and deploys — the
only manual actions are two browser clicks. See **[`bootstrap/README.md`](bootstrap/README.md)**:

```sh
cd bmottershead.github.io/deploy
bootstrap/setup.sh        # defaults target this repo; override OWNER/REPO/etc. for your own
```

### Manual alternative

1. Register a GitHub App (Settings → Developer settings → GitHub Apps): webhook
   off, **Contents: Read and write**, **Callback URL**
   `https://countdown.<your-subdomain>.workers.dev/auth/callback`. Generate a
   **private key** and a **client secret**; note the **App ID** and **Client ID**.
2. Convert the key to PKCS#8 (WebCrypto needs it):
   ```sh
   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
     -in your-app.private-key.pem -out private-key-pkcs8.pem
   ```
3. Put `GITHUB_APP_ID` and `GITHUB_CLIENT_ID` into `wrangler.toml`, then set the
   three secrets and deploy:
   ```sh
   wrangler secret put GITHUB_APP_PRIVATE_KEY < private-key-pkcs8.pem
   wrangler secret put GITHUB_CLIENT_SECRET          # paste at prompt
   openssl rand -base64 32 | wrangler secret put SESSION_SECRET
   wrangler deploy
   rm private-key-pkcs8.pem                          # key now lives only in Cloudflare
   ```
4. Install the App on the repo (App page → Install App → only this repo).

## Configuration

**`[vars]` in `wrangler.toml`** (non-secret):

| Var | Meaning |
|---|---|
| `REPO_OWNER`, `REPO_NAME`, `REPO_BRANCH` | Target repo + branch. |
| `FILE_PATH` | File to write (`most-recent-timestamps.json`). |
| `GITHUB_APP_ID`, `GITHUB_CLIENT_ID` | App identifiers (Client ID is public by design). |
| `SITE_URL` | Where login redirects back to. |
| `ALLOWED_LOGINS` | Comma-separated GitHub logins allowed to commit. Empty = any signed-in user. |
| `ALLOWED_ORIGINS` | Browser origins allowed to call the Worker (CORS). |

**Secrets** (`wrangler secret put …`, never in the repo):

| Secret | Meaning |
|---|---|
| `GITHUB_APP_PRIVATE_KEY` | App private key, **PKCS#8** PEM. |
| `GITHUB_CLIENT_SECRET` | OAuth client secret of the App. |
| `SESSION_SECRET` | Random key for signing session JWTs (HS256). |

## Deploy

```sh
cd bmottershead.github.io/deploy && npx wrangler deploy
```

The site points at the Worker via `WORKER_URL` in `../tally.js` — update it
if your Worker URL differs.

## Test

```sh
# Unauthenticated commit is rejected:
curl -s -X POST https://countdown.riverscape.workers.dev \
  -H 'Content-Type: application/json' -d '{"timestamps":["x"]}'
# -> {"error":"Sign in with GitHub first."}   (HTTP 401)

# Login redirect points at GitHub with the right client_id:
curl -s -i https://countdown.riverscape.workers.dev/auth/login | grep -i '^location:'
```

The full OAuth round-trip needs a real browser. `npx wrangler tail` streams live
logs while you click.

## Notes / hardening

- The private key exists only as a Cloudflare secret; no local copy is kept.
- Commits are gated on a valid session whose login is in `ALLOWED_LOGINS`, and
  carry `"by": "<username>"` for attribution (which flows into the log too).
- The endpoint is still reachable by anyone (CORS only restricts browsers), but
  the session gate means only authorized GitHub users can cause a commit. To
  further harden, add Cloudflare Turnstile or a rate limit.
- The installation token is created per request, scoped to `contents:write` on
  the single repo, and expires in ~1 hour.
