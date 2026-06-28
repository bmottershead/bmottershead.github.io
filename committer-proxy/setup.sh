#!/usr/bin/env bash
#
# One-shot setup for the committer-proxy: registers the GitHub App AND deploys
# the Cloudflare Worker. Two browser clicks: "Create GitHub App" and "Install".
#
# CONFIG LIVES IN wrangler.toml. Edit its [vars] (REPO_OWNER, REPO_NAME,
# SITE_URL, ALLOWED_LOGINS, ALLOWED_ORIGINS) to point at your repo. This script
# fills in only the two values it can't know in advance — GITHUB_APP_ID and
# GITHUB_CLIENT_ID, minted by GitHub when the App is created — and uploads the
# secrets (private key, client secret, session key) to Cloudflare.
#
# Usage:
#   cd bmottershead.github.io/committer-proxy
#   WORKER_CALLBACK=https://<worker>.<subdomain>.workers.dev/auth/callback ./setup.sh
#
# Inputs (env) — only the App-creation bits that aren't Worker config:
#   WORKER_CALLBACK  (required) the Worker's /auth/callback URL, registered on the App
#   APP_NAME         GitHub App name (default committer-proxy)
#   ORG              create the App under an org instead of your account (optional)
#
# Prereqs: node 18+, openssl, wrangler (via npx); logged in to Cloudflare and GitHub.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APPDIR="$HERE/.app"
TOML="$HERE/wrangler.toml"

# Read a quoted [vars] value out of wrangler.toml (the single source of config).
toml_var() {
  sed -n -E "s/^$1[[:space:]]*=[[:space:]]*\"(.*)\"[[:space:]]*\$/\1/p" "$TOML" | head -1
}

if [ -z "${WORKER_CALLBACK:-}" ]; then
  echo "WORKER_CALLBACK is required — the Worker's /auth/callback URL to register on the App." >&2
  echo "e.g. WORKER_CALLBACK=https://countdown.riverscape.workers.dev/auth/callback ./setup.sh" >&2
  exit 1
fi

# create-app.mjs inputs. SITE_URL is read from wrangler.toml so config isn't
# entered twice; the rest are App-creation-only and aren't Worker [vars].
export APP_NAME="${APP_NAME:-committer-proxy}"
export CALLBACK_URL="$WORKER_CALLBACK"
export ORG="${ORG:-}"
SITE_URL="$(toml_var SITE_URL)"
[ -n "$SITE_URL" ] || { echo "SITE_URL is not set in wrangler.toml [vars]." >&2; exit 1; }
export SITE_URL

for tool in node openssl npx; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool"; exit 1; }
done

cd "$HERE"

# Leave the tree clean. The PKCS#8 temp and wrangler's cache are always disposable.
# The .app credential dir is removed only on success — once the secrets are safely
# in Cloudflare. On failure it's kept so you can retry without re-minting the App.
DONE=0
cleanup() {
  rm -rf "$HERE/.wrangler" "$APPDIR/private-key-pkcs8.pem"
  if [ "$DONE" = "1" ]; then
    rm -rf "$APPDIR"
  elif [ -d "$APPDIR" ]; then
    echo "Note: credentials kept in $APPDIR (setup did not finish). Retry, or: rm -rf \"$APPDIR\"" >&2
  fi
}
trap cleanup EXIT

echo "==> 1/5  Create the GitHub App (a browser window will open)"
node "$HERE/create-app.mjs"
# shellcheck disable=SC1091
source "$APPDIR/app.env"   # provides APP_ID, CLIENT_ID, APP_SLUG, INSTALL_URL

echo "==> 2/5  Convert the private key to PKCS#8 (WebCrypto needs this)"
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in "$APPDIR/private-key.pem" -out "$APPDIR/private-key-pkcs8.pem"

echo "==> 3/5  Write the new App's IDs into wrangler.toml"
# Only these two can't be known until the App exists; everything else in
# [vars] you set yourself.
sed -i -E \
  -e "s|^GITHUB_APP_ID = .*|GITHUB_APP_ID = \"$APP_ID\"|" \
  -e "s|^GITHUB_CLIENT_ID = .*|GITHUB_CLIENT_ID = \"$CLIENT_ID\"|" \
  "$TOML"

echo "==> 4/5  Upload secrets to the Worker"
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < "$APPDIR/private-key-pkcs8.pem"
npx wrangler secret put GITHUB_CLIENT_SECRET   < "$APPDIR/client-secret.txt"
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET

echo "==> 5/5  Deploy"
npx wrangler deploy

DONE=1
cat <<EOF

✅ Done. GitHub App "$APP_SLUG" (id $APP_ID) created and the Cloudflare Worker is deployed.

FINAL manual step — install the App on your repo (one click):
   $INSTALL_URL

The local .app credentials have been removed; the secrets now live only in Cloudflare.
EOF
