# Bootstrap: create the GitHub App + deploy the Worker

This automates everything that was done by hand the first time, down to **two
browser clicks**. It uses GitHub's [App Manifest flow], which is the only
programmatic way to create an app and obtain its private key + client secret in
one shot (GitHub deliberately has no pure-headless "create app" API).

[App Manifest flow]: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest

## What it does

1. **create-app.mjs** serves a local one-button page, posts the manifest to
   GitHub, and on redirect exchanges the temporary `code` for the app's
   **App ID, private key (.pem), client id, and client secret** — saved to
   `bootstrap/.app/`.
2. **setup.sh** then, with no further interaction:
   - converts the private key to PKCS#8,
   - writes App ID / Client ID / repo / site / allowlist into `wrangler.toml`,
   - uploads `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_SECRET`, and a freshly
     generated `SESSION_SECRET` as Worker secrets,
   - deploys the Worker.
3. It prints the **install URL** — your one remaining click to install the app
   on the repo.

So the manual surface is just: **click "Create GitHub App"**, then **click
"Install"**. Everything else is scripted.

## Prerequisites

- `node` (18+), `openssl`, and `wrangler` (via `npx`) available.
- Logged in to Cloudflare (`npx wrangler whoami`) and to GitHub in your browser.

## Run it

```sh
cd bmottershead.github.io/deploy

# Defaults target bmottershead/bmottershead.github.io. Override for your own:
OWNER=you \
REPO=you.github.io \
SITE_URL=https://you.github.io \
WORKER_CALLBACK=https://countdown.<your-subdomain>.workers.dev/auth/callback \
bootstrap/setup.sh
```

- `WORKER_CALLBACK` must be the deployed Worker's `/auth/callback` URL (worker
  name + your `workers.dev` subdomain). It's registered as the app's OAuth
  callback, so it has to match where the Worker actually runs.
- Set `ORG=your-org` to create the app under an organization instead of your
  personal account.
- `ALLOWED_LOGINS` defaults to `OWNER`; set it to a comma-separated list to let
  more people run the countdown (empty = any signed-in GitHub user).

## After it finishes

- Click the printed **install** link.
- Delete the local secrets: `rm -rf bootstrap/.app`.
- The site (`index.html` etc.) already points at the Worker; if your Worker URL
  differs, update `WORKER_URL` in `tally.js`.

## Notes

- This creates a **new** app each run. If you already have one configured, you
  don't need this except to reproduce from scratch or share the project.
- `bootstrap/.app/` holds the private key and client secret — it's gitignored.
  Treat it like any credential; remove it once secrets are uploaded.
- `sed -i` here uses GNU semantics (Linux). On macOS, either install GNU sed or
  change `sed -i` to `sed -i ''`.
