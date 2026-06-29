# Plan 2 — Self-hosted on Cloudflare via `setup.sh` (one token paste)

**Status:** primary — build this first. The `committer-proxy/setup.sh` and
`create-app.mjs` scaffolding exists but has **never been run end-to-end** (there's
a never-run bug in `create-app.mjs`: the App manifest was missing
`hook_attributes.url`). So "mostly done" = the shape exists; it is unverified.

## Goal

The owner of a **fork** runs `./setup.sh` locally; it stands up *their own*
GitHub App **and** *their own* Cloudflare Worker for *their own* fork. No
operator to trust. Minimum pasting: **one Cloudflare API token, once.** No
GitHub secret is ever pasted — the script captures them from the App-creation
response and pipes them straight into Cloudflare.

## The irreducible interactive steps (cannot be removed)

GitHub has **no headless API to mint a repo-write credential**, so two browser
moments are unavoidable, by GitHub's design:

1. **Create App** — one click on GitHub's App-creation confirmation page.
2. **Install App** — one click to install it on the fork.

Everything else is automated. (See `docs/why-not-zero-touch.md` reasoning in the
conversation: CORS only blocks the *browser*; the script defeats CORS; the
remaining wall is GitHub requiring human consent to create a credential, which
applies to scripts and browsers equally.)

## End-state visitor experience

```
fork → clone → ./setup.sh
  → (browser) click "Create"           # creates their GitHub App
  → (browser) click "Install"          # installs it on their fork
  → done; their Pages site commits timestamps to their own fork
```

**Friction tally:** **1 paste** (a Cloudflare API token) — or **0** if they use
`wrangler login` instead. Browser clicks: Create App, Install App (+ maybe the
Pages/Actions toggles). **Zero** GitHub secrets pasted.

## `setup.sh` flow (rebuild of the existing script)

1. **Preflight** — check `node` 18+, `npx wrangler`; detect the fork's
   `owner/repo` from `git remote get-url origin`.
2. **Cloudflare auth — the one paste** — prompt for a `CF_API_TOKEN` scoped
   *Workers Scripts: Edit* (or accept an existing `wrangler login` for
   zero-paste-but-extra-browser). Derive the account id via `GET /accounts`.
3. **Pre-compute the Worker URL** — read the account's `workers.dev` subdomain
   (`GET /accounts/{id}/workers/subdomain`) + chosen worker name, so the App's
   OAuth callback is correct **at creation time** (no post-hoc edit). Flag if the
   subdomain isn't claimed yet (one-time manual step on brand-new CF accounts).
4. **Create the GitHub App** via a fixed `create-app.mjs`:
   - Manifest **must** include `hook_attributes.url` (the never-run bug),
     `callback_urls: [<workerURL>/auth/callback]`,
     `redirect_url: http://localhost:<port>/callback`,
     `default_permissions: { contents: write }`, `public: false`,
     `default_events: []`.
   - Opens the browser → user clicks **Create** → receives `?code` →
     exchanges at `POST /app-manifests/{code}/conversions` → gets
     `app_id, client_id, client_secret, pem, slug, html_url`.
5. **Convert the key** PKCS#1 → PKCS#8 (WebCrypto in the Worker needs PKCS#8):
   `openssl pkcs8 -topk8 -nocrypt`, or the in-repo JS converter
   (`setup/pem.js: pkcs1ToPkcs8Pem`).
6. **Write `committer-proxy/wrangler.toml`** for the fork: `GITHUB_APP_ID`,
   `GITHUB_CLIENT_ID` (both public), `REPO_OWNER`/`REPO_NAME` (the fork),
   `SITE_URL`, `ALLOWED_LOGINS=<owner>`, `ALLOWED_ORIGINS`, worker `name`.
7. **Pipe secrets in (no pasting):** `wrangler secret put` for
   `GITHUB_APP_PRIVATE_KEY` (converted pem), `GITHUB_CLIENT_SECRET` (from the
   conversion), `SESSION_SECRET` (`openssl rand -base64 32`) — all fed
   programmatically via stdin.
8. **Deploy** — `wrangler deploy`. Worker live at the precomputed URL.
9. **Wire the frontend & push** — set `WORKER_URL` in `tally.js`,
   `git commit` + `git push` to the fork (the "commit and a push").
10. **Install the App** — open `<html_url>/installations/new` → user clicks
    **Install** on the fork, selecting "only this repository."
11. **Enable Pages + Actions** on the fork via `gh api` if present
    (`PUT /repos/{o}/{r}/pages`, `PUT /repos/{o}/{r}/actions/permissions`),
    else print the two toggles. (Forks disable both by default.)
12. **Clean up** transient key files (`.app/`); secrets now live only in
    Cloudflare. Print the live site URL.

## Tasks

1. Fix `committer-proxy/create-app.mjs` (`hook_attributes.url`; capture `slug` +
   install URL; confirm it actually runs).
2. Rewrite `committer-proxy/setup.sh`: detect fork from git remote; CF auth
   (token paste or `wrangler login`); precompute worker URL/subdomain; drive
   create-app; convert key; write `wrangler.toml`; pipe 3 secrets; deploy; patch
   `tally.js` `WORKER_URL`; commit+push; open install URL; enable Pages+Actions;
   cleanup.
3. Confirm `committer-proxy/worker.js` single-repo path still works with the
   per-fork vars (it already targets `REPO_OWNER`/`REPO_NAME`).
4. **Test end-to-end against a throwaway fork.** Nothing here has been run.
5. README: "fork → `./setup.sh` → Create → Install → done"; call out the single
   token paste explicitly.

## Risks / notes

- Needs a Cloudflare account + `npx wrangler` + Node 18+.
- `workers.dev` subdomain may need a one-time claim on new CF accounts.
- Account id when using an API token: `GET /accounts`.
- Each forker creates their **own** GitHub App (per-fork) — fine, that's the
  self-hosted property.
- `SITE_URL`/Pages path differs for user-pages (`<owner>.github.io`) vs
  project-pages (`<owner>.github.io/<repo>`).
- `gh` CLI optional — degrade gracefully to printed instructions.

## Contrast with Plan 1

Plan 2 = **no trust in anyone**; costs the forker a CF account + one token paste
+ two browser clicks. Plan 1 (shared operator) = lowest friction but visitors
trust the operator (capped at `contents:write` on their own repo). We're doing
both; this one first.
