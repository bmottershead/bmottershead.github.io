#!/usr/bin/env bash
#
# Teardown — the inverse of setup.sh. Deletes this deployment's Cloudflare Worker
# automatically, then deep-links the GitHub App's Delete page.
#
# GitHub has NO API to delete a GitHub App (App *deletion* is browser-only, just
# like App *creation* via the manifest flow), so the App is the one manual click;
# everything else is automatic.
#
# Run from a clone of the deployment:
#   cd <repo>/committer-proxy && ./teardown.sh
#
# Optional env: WORKER_NAME (else read from local wrangler.toml, else tally-<repo>).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
TOML="$HERE/wrangler.toml"

say() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

for t in git npx; do command -v "$t" >/dev/null || die "missing required tool: $t"; done

remote="$(git -C "$REPO_ROOT" config --get remote.origin.url || true)"
[ -n "$remote" ] || die "no git 'origin' remote in $REPO_ROOT"
repo_slug="$(printf '%s' "$remote" \
  | sed -E 's#^git@github\.com:##; s#^ssh://git@github\.com/##; s#^https://github\.com/##; s#\.git$##')"
REPO_OWNER="${repo_slug%%/*}"
REPO_NAME="${repo_slug##*/}"
repo_lc="$(printf '%s' "$REPO_NAME" | tr '[:upper:]' '[:lower:]')"
derived="tally-$(printf '%s' "$repo_lc" | tr -c 'a-z0-9-' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')"

# Prefer the name actually deployed (local wrangler.toml), then the derived name.
if [ -z "${WORKER_NAME:-}" ] && [ -f "$TOML" ]; then
  WORKER_NAME="$(sed -n -E 's/^name[[:space:]]*=[[:space:]]*"(.*)"[[:space:]]*$/\1/p' "$TOML" | head -1)"
fi
WORKER_NAME="${WORKER_NAME:-$derived}"

# Where the App lives (org vs personal), for the delete deep-link.
app_base="https://github.com/settings/apps"
if command -v gh >/dev/null; then
  owner_type="$(gh api "users/$REPO_OWNER" --jq .type 2>/dev/null || true)"
  if [ "$owner_type" = "Organization" ]; then
    app_base="https://github.com/organizations/$REPO_OWNER/settings/apps"
  fi
fi
APP_URL="$app_base/$derived"   # slug usually matches the name setup.sh used

say "Deleting Cloudflare Worker '$WORKER_NAME' from this account:"
npx --yes wrangler whoami 2>&1 | sed -n '1,8p' || true
npx --yes wrangler delete --name "$WORKER_NAME"   # wrangler prompts to confirm

say "Worker gone. Final step — delete the GitHub App in the browser (no API for it):"
echo "   $APP_URL   ->  Advanced -> Delete GitHub App  (type the name to confirm)"
echo "   If that slug 404s, find the app under: $app_base"
if command -v xdg-open >/dev/null; then xdg-open "$APP_URL" >/dev/null 2>&1 || true; fi
