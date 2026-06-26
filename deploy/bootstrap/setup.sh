#!/usr/bin/env bash
#
# One-shot bootstrap: create the GitHub App from a manifest, configure the
# Worker, upload secrets, and deploy. The only manual actions are two browser
# clicks — "Create GitHub App" and (at the end) "Install".
#
# Usage:
#   cd bmottershead.github.io/deploy
#   OWNER=you REPO=you.github.io SITE_URL=https://you.github.io \
#     WORKER_CALLBACK=https://countdown.<sub>.workers.dev/auth/callback \
#     bootstrap/setup.sh
#
# Defaults target this repo. Set ORG=your-org to create under an organization.
#
# NOTE: this creates a NEW GitHub App. If you already set one up by hand, you
# only need this to reproduce from scratch or hand the project to someone else.

set -euo pipefail

# ---- Config ---------------------------------------------------------------
export OWNER="${OWNER:-bmottershead}"
export REPO="${REPO:-${OWNER}.github.io}"
export APP_NAME="${APP_NAME:-countdown-committer}"
export SITE_URL="${SITE_URL:-https://${OWNER}.github.io}"
export WORKER_CALLBACK="${WORKER_CALLBACK:-https://countdown.riverscape.workers.dev/auth/callback}"
export ORG="${ORG:-}"
ALLOWED_LOGINS="${ALLOWED_LOGINS:-$OWNER}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-${SITE_URL},http://localhost:8000}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPDIR="$ROOT/bootstrap/.app"
cd "$ROOT"

for tool in node openssl npx; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool"; exit 1; }
done

echo "==> 1/5  Create the GitHub App (a browser window will open)"
node bootstrap/create-app.mjs
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

cat <<EOF

✅ Worker deployed and configured for App "$APP_SLUG" (id $APP_ID).

FINAL manual step — install the app on your repo (one click):
   $INSTALL_URL

Then remove the local secret files:
   rm -rf "$APPDIR"
EOF
