# Plan 1 — Shared multi-tenant operator backend

**Status:** backend code written (untested), gated behind `MULTI_TENANT`. Still
needs: you registering the public App, the front-end `APP_SLUG`, and end-to-end
testing — do those after Plan 2 (self-hosted) is verified working.

**Done so far (committed, unverified):**
- `worker.js`: `MULTI_TENANT` mode — per-repo installation tokens
  (`getInstallationToken(env, owner, repo)`), `/commit` takes `{owner, repo}`
  with an `owner === session.login` gate + `data/<login>/` path prefix, dynamic
  validated OAuth return origin (`?site=`, github.io/localhost only), and a
  `GET /installed?owner=&repo=` endpoint. Single-tenant is unchanged (default).
- `tally.js`: self-detects `owner/repo` from the Pages URL, sends them on commit,
  passes `?site=` on login, and shows an Install link when `APP_SLUG` is set.
- `wrangler.toml`: documents the commented `MULTI_TENANT` toggle.

**Still TODO:** register the public App (`contents:write` only), set `APP_SLUG`
in `tally.js`, deploy an operator Worker with `MULTI_TENANT="true"` +
empty `ALLOWED_LOGINS`, and test end-to-end.

## Goal

You (the operator) run **one** Worker + **one** public GitHub App. Anyone forks
the repo and their hosted Pages site writes timestamps to **their own fork** via
your shared backend. The visitor pays nothing, pastes nothing, and installs no
infrastructure — the "click Install in the Play Store" experience.

The Play-Store ease comes *from* the central operator absorbing the complexity.
You cannot have frictionless **and** trustless: this plan is the frictionless,
trusted-operator end. (Plan 2 is the trustless, higher-friction end.)

## End-state visitor experience

```
fork → enable Pages + Actions → open site
  → Sign in with GitHub
  → Install App on this repo   (one click, "only this repository")
  → count; it commits to their own fork
```

**Friction tally:** 0 pastes, 0 secrets, 0 Cloudflare account. Clicks: enable
Pages, enable Actions, Sign in, Install App.

## Pieces to build

### 1. Register the public GitHub App (you, once, in a browser)

- Permissions: **`contents: write` only** (plus mandatory `metadata: read`). No
  `workflows`, nothing else — this is the hard cap on what the operator can ever
  touch. (Notably, `contents:write` alone **cannot** modify `.github/workflows/`,
  which needs a separate `workflows` permission — blocks the worst escalation.)
- **Public** (so others can install).
- Enable *"Request user authorization (OAuth) during installation"* so sign-in +
  install can be a single combined flow.
- Callback URL → your Worker's `/auth/callback`; webhook off.

### 2. Worker changes (`committer-proxy/worker.js`)

Today it is hardwired to one repo (`REPO_OWNER`/`REPO_NAME`). Multi-tenant needs:

- **Per-repo installation tokens:** `getRepoInstallationToken(owner, repo)` =
  `GET /repos/{owner}/{repo}/installation` (as the App JWT) → mint an
  installation token scoped to *that* repo.
- **`/commit` takes a target:** `{ owner, repo, path, content, message }` instead
  of a fixed repo.
- **Ownership gate (key security rule):** require `owner === session.login` — a
  user may only write to repos **they own**. This is what stops user A writing to
  user B's fork.
- **Path allowlist:** restrict writes to `data/<login>/…` / the timestamps files.
  (Soft — guards against bugs and hijacked sessions, not a malicious operator.)
- **Dynamic return origin:** `SITE_URL` is currently a fixed var; multi-tenant
  login must redirect back to *the fork that initiated it*. Carry the origin in
  the OAuth `state` and **validate it matches `*.github.io`** before redirecting
  (open-redirect guard).
- **`ALLOWED_LOGINS` → empty** (any signed-in user); the gate becomes ownership,
  not an allowlist.
- Add **`GET /installed?owner=&repo=`** so the page can decide whether to show
  the Install button.

### 3. Frontend (`tally.js`)

- **Self-identify the repo** from `location` (`<owner>.github.io` → repo
  `<owner>.github.io`; `<owner>.github.io/<repo>` → that repo) so a fork works
  with no config edit.
- Bake the public **`APP_SLUG`** constant.
- After sign-in, call `/installed`; if not installed, show **"Install on this
  repo"** → deep-link `https://github.com/apps/<slug>/installations/new` and
  handle the return.
- Send `{ owner, repo }` with each commit.

### 4. The Action

`append-log.yml` rides along in the fork and commits with `GITHUB_TOKEN` (no
operator involvement). **Forks disable Actions and Pages by default** — two
one-time toggles the visitor flips.

## Security / trust posture (document honestly)

Installing the App = trusting the operator with `contents:write` on the repos the
user selects. GitHub-enforced hard limits (operator cannot exceed, even if
malicious):

- `contents: write` **only** — no Actions secrets, settings, collaborators,
  webhooks, repo deletion, or workflow files.
- **Repository selection** at install — user picks "only this repo" → blast
  radius is that one repo.
- **Instant revocation** — uninstall kills all access.

Soft (trust-based, not operator-proof): the worker's path/ownership rules — a
key-holder could ignore them. No cryptographic fix; this is intrinsic to any
shared-backend model (same trust as any Marketplace app).

Optional hardening: act with **user-to-server tokens** (short-lived, tied to an
active session) to lower standing operator power.

For a **demo** this is fine: install on a throwaway fork, "only this repo,"
revoke when done.

## Tasks

1. Register the public GitHub App (`contents:write` only, OAuth callback).
2. Worker: per-repo installation token; `/commit` target + ownership gate; path
   prefix; dynamic validated return origin; empty `ALLOWED_LOGINS`; `/installed`.
3. Frontend: self-detect owner/repo; `APP_SLUG`; install button + post-install
   return; target repo in commit.
4. Visitor README (fork → enable Pages → enable Actions → sign in → install) +
   trust/security note; operator one-time setup doc.
5. End-to-end test with a throwaway fork.

## Contrast with Plan 2

Plan 1 = lowest friction, visitors trust you (capped at `contents:write` on their
own repo, revocable). Plan 2 = no trust in anyone, costs the forker a CF account
+ one token paste + two clicks.
