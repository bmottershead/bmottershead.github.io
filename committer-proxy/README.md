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
| `wrangler.toml.example` | Template for the Worker config. The real `wrangler.toml` is **generated** (gitignored) — `setup.sh` copies this and fills it in. |
| `setup.sh` | One-shot: registers the GitHub App **and** deploys the Worker. |
| `teardown.sh` | Inverse of `setup.sh`: deletes the Worker, deep-links the App's delete page. |
| `create-app.mjs` | The App-creation gadget (GitHub manifest flow) `setup.sh` drives; it builds the manifest inline. |
| `../config.js` | The **one** deployment-specific frontend file (`export const WORKER_URL`). `setup.sh` writes it; `tally.js` imports it, so app source stays identical across deployments. |
| `../index.html`, `../tally.js`, `../style.css` | The demo front-end (sign-in UI + count / new batch / archive). Identical across deployments — never edited by setup. |
| `../data/<login>/timestamps.json` | Where the demo archives each user's batches (written via `/commit`). |

## Routes

| Method + path | Purpose |
|---|---|
| `GET /auth/login` | Redirect to GitHub's OAuth authorize page. |
| `GET /auth/callback` | Exchange the code, mint a session JWT, redirect to `SITE_URL/#session=…`. |
| `GET /auth/me` | Return the signed-in user (`Authorization: Bearer <jwt>`) or 401. |
| `POST /commit` | Commit a file. Body: `{ path, content, message?, branch? }`. Requires a valid session whose login is allowed. |

## Setup

### Recommended: `setup.sh` (fork → one command)

Fork `bmottershead.github.io`, clone your fork, then:

```sh
cd <your-fork>/committer-proxy
./setup.sh
```

That's it. The script **figures out your repo from the git remote** (owner, repo,
Pages URL, allowed login, worker name — no `wrangler.toml` editing), then:

1. deploys the Worker once to **discover its `workers.dev` URL** (so the App's
   OAuth callback is correct from the start — no chicken-and-egg);
2. **creates your GitHub App** — one browser click, "Create";
3. converts the key to PKCS#8, writes the App's two public IDs into
   `wrangler.toml`, and **pipes the three secrets to Cloudflare** (no secret is
   ever pasted);
4. re-deploys, writes `config.js` (the one per-deploy frontend file) to point at
   your Worker, and commits + pushes **just that** to your fork (app source is
   untouched);
5. enables **Pages + Actions** on the fork (via `gh` if present), and prints the
   **Install** link — one browser click to finish.

On success it deletes the transient `.app/` dir, so the secrets live only in
Cloudflare. On failure it keeps `.app/` so a re-run won't re-mint the App.

**The only thing you might paste is a Cloudflare API token, once** — and only if
you are *not* already `wrangler login`'d. Set `CF_API_TOKEN` (scope
*Workers Scripts: Edit*) or run `npx wrangler login` beforehand.

**Prereqs:** `node` 18+, `openssl`, `npx` (wrangler), `git`. Optional: `gh` (to
auto-enable Pages/Actions; otherwise the script prints the two toggles).

**Optional env overrides:** `APP_NAME`, `WORKER_NAME`, `ORG`, `CF_API_TOKEN`,
`SITE_URL`, `WORKER_URL`.

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
3. Create `wrangler.toml` from the template and fill it in, then set the three
   secrets and deploy:
   ```sh
   cp wrangler.toml.example wrangler.toml   # then edit its [vars] for your repo
   wrangler secret put GITHUB_APP_PRIVATE_KEY < private-key-pkcs8.pem
   wrangler secret put GITHUB_CLIENT_SECRET          # paste at prompt
   openssl rand -base64 32 | wrangler secret put SESSION_SECRET
   wrangler deploy
   rm private-key-pkcs8.pem                          # key now lives only in Cloudflare
   ```
4. Point the site at the Worker: set `WORKER_URL` in `../config.js`.
5. Install the App on the repo (App page → Install App → only this repo).

## Configuration

**`[vars]` in `wrangler.toml`** (non-secret; generated from
`wrangler.toml.example`, gitignored):

| Var | Meaning |
|---|---|
| `REPO_OWNER`, `REPO_NAME`, `REPO_BRANCH` | Target repo + default branch (the only repo the Worker can write to). |
| `GITHUB_APP_ID`, `GITHUB_CLIENT_ID` | App identifiers (both public). **Filled by `setup.sh`** on App creation — you don't set these by hand. |
| `SITE_URL` | Where login redirects back to. |
| `ALLOWED_LOGINS` | Comma-separated GitHub logins allowed to commit. Empty = any signed-in user. |
| `ALLOWED_ORIGINS` | Browser origins allowed to call the Worker (CORS). |

**Secrets** (`wrangler secret put …`, never in the repo):

| Secret | Meaning |
|---|---|
| `GITHUB_APP_PRIVATE_KEY` | App private key, **PKCS#8** PEM. |
| `GITHUB_CLIENT_SECRET` | OAuth client secret of the App. |
| `SESSION_SECRET` | Random key for signing session JWTs (HS256). |

## Teardown

```sh
cd <repo>/committer-proxy && ./teardown.sh
```

Deletes this deployment's **Worker** automatically (name read from the local
`wrangler.toml`, else derived), then deep-links the **GitHub App**'s delete page.
The App is the one manual click — GitHub has no App-*deletion* API, mirroring how
App *creation* needs a browser "Create" click. Override the worker name with
`WORKER_NAME=...`.

## Re-deploy

`setup.sh` is only needed to create the App. To redeploy code or config changes:

```sh
cd bmottershead.github.io/committer-proxy && npx wrangler deploy
```

The site points at the Worker via `WORKER_URL` in `../config.js` — update it
if your Worker URL differs. (`tally.js` imports it, so app source never changes.)

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
