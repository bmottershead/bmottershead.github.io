#!/usr/bin/env bash
#
# One-shot setup for the committer-proxy: registers the GitHub App AND deploys
# the Cloudflare Worker that is its OAuth + commit proxy. One App, one proxy —
# they're a matched pair, created together. The only manual actions are two
# browser clicks: "Create GitHub App" and (at the end) "Install".
#
# Usage:
#   cd bmottershead.github.io/committer-proxy
#   OWNER=you REPO=you.github.io SITE_URL=https://you.github.io \
#     WORKER_CALLBACK=https://<worker>.<subdomain>.workers.dev/auth/callback \
#     ./setup.sh
#
# Config (env):
#   OWNER, REPO       target repo the Worker may write to (default bmottershead/...)
#   APP_NAME          GitHub App name (default committer-proxy)
#   SITE_URL          where login redirects back to (default https://OWNER.github.io)
#   WORKER_CALLBACK   the Worker's /auth/callback URL, registered on the App
#   ORG               create the App under an org instead of your account (optional)
#   ALLOWED_LOGINS    comma-separated GitHub logins allowed to commit (default OWNER)
#   ALLOWED_ORIGINS   browser origins allowed to call the Worker (default SITE_URL + localhost)
#
# Prereqs: node 18+, openssl, wrangler (via npx); logged in to Cloudflare and GitHub.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APPDIR="$HERE/.app"

# ---- Config ---------------------------------------------------------------
export OWNER="${OWNER:-bmottershead}"
export REPO="${REPO:-${OWNER}.github.io}"
export APP_NAME="${APP_NAME:-committer-proxy}"
export SITE_URL="${SITE_URL:-https://${OWNER}.github.io}"
# The App's OAuth callback = this Worker's /auth/callback. Override for your own
# worker name + workers.dev subdomain.
export CALLBACK_URL="${WORKER_CALLBACK:-https://countdown.riverscape.workers.dev/auth/callback}"
export ORG="${ORG:-}"
ALLOWED_LOGINS="${ALLOWED_LOGINS:-$OWNER}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-${SITE_URL},http://localhost:8000}"

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

echo "==> 3/5  Write config into wrangler.toml"
sed -i -E \
  -e "s|^GITHUB_APP_ID = .*|GITHUB_APP_ID = \"$APP_ID\"|" \
  -e "s|^GITHUB_CLIENT_ID = .*|GITHUB_CLIENT_ID = \"$CLIENT_ID\"|" \
  -e "s|^REPO_OWNER = .*|REPO_OWNER = \"$OWNER\"|" \
  -e "s|^REPO_NAME = .*|REPO_NAME = \"$REPO\"|" \
  -e "s|^SITE_URL = .*|SITE_URL = \"$SITE_URL\"|" \
  -e "s|^ALLOWED_LOGINS = .*|ALLOWED_LOGINS = \"$ALLOWED_LOGINS\"|" \
  -e "s|^ALLOWED_ORIGINS = .*|ALLOWED_ORIGINS = \"$ALLOWED_ORIGINS\"|" \
  wrangler.toml

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
