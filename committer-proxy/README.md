# committer-proxy — GitHub OAuth + commit proxy

A self-contained **OAuth + commit proxy**: one **GitHub App** plus one
**Cloudflare Worker** that backs it. The Worker handles **"Login with GitHub"**
and lets an authorized user commit **arbitrary files** to one configured repo.
It's **content-blind** — the browser supplies the `path`, `content`, and commit
`message`; the Worker verifies the session, mints a short-lived installation
token scoped to `contents:write` on the one repo, stamps the commit author with
the authenticated user, and commits. **No credentials ever reach the browser.**

**One App, one proxy.** The Worker is the App's confidential **OAuth client** and
sole backend: the App's Client Secret and Private Key live only in the Worker's
Cloudflare secret store. The "content-blind" genericness is toward **front-ends**
— any static site can POST to the Worker; the tally-counter demo in this repo is
one such front-end. (If you wanted a second, independently-revocable proxy you'd
register a *separate* GitHub App for it, not share this one's keys.)

```
                       sign in
browser (Pages) ──GET /auth/login──▶ Worker ──▶ GitHub OAuth ──▶ Worker
      ▲                                                            │ mints session JWT
      └──────────────── #session=<jwt> ───────────────────────────┘

browser ──POST /commit {path,content,message} + Bearer <jwt>──▶ Worker ──App token──▶ Contents API
                                                                (gated on ALLOWED_LOGINS)
```

This directory is **excluded from the published site** (`committer-proxy` is in
the repo's `_config.yml` Jekyll `exclude`), so the Worker source isn't served.

## Where things live

| Path | Role |
|------|------|
| `worker.js` | The Worker: auth routes + generic gated commit. |
| `wrangler.toml` | Non-secret config (`[vars]`). |
| `setup.sh` | One-shot: registers the GitHub App **and** deploys the Worker. |
| `create-app.mjs` | The App-creation gadget (GitHub manifest flow) `setup.sh` drives. |
| `app-manifest.json` | Reference shape of the App manifest (the real one is built at runtime). |
| `../index.html`, `../tally.js`, `../style.css` | The demo front-end (sign-in UI + count/save/history). It owns the file paths/formats. |
| `../.github/workflows/append-log.yml` | Demo Action: appends each `most-recent-timestamps.json` commit to `timestamps.json`. |

## Routes

| Method + path | Purpose |
|---|---|
| `GET /auth/login` | Redirect to GitHub's OAuth authorize page. |
| `GET /auth/callback` | Exchange the code, mint a session JWT, redirect to `SITE_URL/#session=…`. |
| `GET /auth/me` | Return the signed-in user (`Authorization: Bearer <jwt>`) or 401. |
| `POST /commit` | Commit a file. Body: `{ path, content, message?, branch? }`. Requires a valid session whose login is allowed. |

## Setup

### Recommended: `setup.sh`

One command creates the GitHub App **and** deploys the Worker. The only manual
actions are two browser clicks — "Create GitHub App" and (at the end) "Install".

```sh
cd bmottershead.github.io/committer-proxy

# Defaults target bmottershead/bmottershead.github.io. Override for your own.
# WORKER_CALLBACK is this Worker's deployed /auth/callback URL.
OWNER=you REPO=you.github.io SITE_URL=https://you.github.io \
WORKER_CALLBACK=https://<worker>.<your-subdomain>.workers.dev/auth/callback \
  ./setup.sh
```

It registers the App, writes the credentials to a transient `.app/`, converts
the key to PKCS#8, fills in `wrangler.toml`, uploads the three secrets, deploys,
and then **deletes `.app/`** — the secrets now live only in Cloudflare. (On
failure it keeps `.app/` so you can retry without re-minting the App.)

**Prereqs:** `node` (18+), `openssl`, `wrangler` (via `npx`); logged in to
Cloudflare (`npx wrangler whoami`) and to GitHub in your browser.

### Manual alternative

1. Register a GitHub App (Settings → Developer settings → GitHub Apps): webhook
   off, **Contents: Read and write**, **Callback URL**
   `https://<worker>.<your-subdomain>.workers.dev/auth/callback`. Generate a
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
| `REPO_OWNER`, `REPO_NAME`, `REPO_BRANCH` | Target repo + default branch (the only repo the Worker can write to). |
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

## Re-deploy

`setup.sh` is only needed to create the App. To redeploy code or config changes:

```sh
cd bmottershead.github.io/committer-proxy && npx wrangler deploy
```

The site points at the Worker via `WORKER_URL` in `../tally.js` — update it
if your Worker URL differs.

## Test

```sh
# Unauthenticated commit is rejected:
curl -s -X POST https://countdown.riverscape.workers.dev/commit \
  -H 'Content-Type: application/json' -d '{"path":"x.json","content":"{}"}'
# -> {"error":"Sign in with GitHub first."}   (HTTP 401)

# Login redirect points at GitHub with the right client_id:
curl -s -i https://countdown.riverscape.workers.dev/auth/login | grep -i '^location:'
```

The full OAuth round-trip needs a real browser. `npx wrangler tail` streams live
logs while you click.

## Notes / hardening

- The private key exists only as a Cloudflare secret; no local copy is kept.
- Commits are gated on a valid session whose login is in `ALLOWED_LOGINS`. The
  Worker stamps the **git commit author** with the authenticated user, so
  attribution is authoritative regardless of the file content the app sends.
- The endpoint is still reachable by anyone (CORS only restricts browsers), but
  the session gate means only authorized GitHub users can cause a commit. To
  further harden, add Cloudflare Turnstile or a rate limit.
- The installation token is created per request, scoped to `contents:write` on
  the single repo, and expires in ~1 hour.
- **Content-blind:** `/commit` can write *any path within the one repo*, so any
  allowed user can overwrite any file (including `.github/workflows/*` and the
  site itself). That's acceptable with a single trusted `ALLOWED_LOGINS`. For
  multiple/untrusted users, add a path allowlist and/or per-user ownership rules
  (the Worker would then need a little app awareness).

## Future work

- **Per-user write isolation (deferred — YAGNI; single user today).** If this
  ever goes multi-user, add a config toggle `ENFORCE_USER_PREFIX`. When on,
  `handleCommit` requires the committed path to start with `<login>/` (the
  trailing slash matters, so `bmottershead/` doesn't also match
  `bmottershead-evil/`). Keep the existing `..` / leading-`/` rejection *before*
  the prefix check, and use the login's canonical casing as the folder name
  (git paths are case-sensitive). Reads stay open (public repo); only writes are
  gated. `ENFORCE_USER_PREFIX` on + empty `ALLOWED_LOGINS` = any GitHub user can
  sign in but only write under their own `/<login>/` folder. The app would then
  keep its files under `<login>/` and the Action would key off that path — an
  app-side change, since path/identity rules don't break the content-blind
  property.
