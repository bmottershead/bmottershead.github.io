#!/usr/bin/env bash
#
# One-command setup for a *forked* committer-proxy site.
#
# Run this after you fork bmottershead.github.io and clone your fork:
#   cd <your-fork>/committer-proxy
#   ./setup.sh
#
# It figures out your repo from the git remote, creates your own GitHub App
# (one browser click), deploys your own Cloudflare Worker, wires the site to it,
# and installs the App on your repo (one browser click). The only thing you may
# paste is a Cloudflare API token, once — and only if you aren't already logged
# in with `wrangler login`. No GitHub secret is ever pasted: the script captures
# the App's private key and client secret and pipes them straight to Cloudflare.
#
# Prereqs: node 18+, openssl, npx (wrangler), git. Optional: gh (to auto-enable
# Pages + Actions on the fork; otherwise the script prints the two toggles).
#
# Optional env overrides:
#   APP_NAME      GitHub App name         (default: tally-<repo>)
#   WORKER_NAME   Cloudflare Worker name  (default: existing name in
#                                           wrangler.toml, else tally-<repo>)
#   ORG           create the App under an org instead of your account
#   CF_API_TOKEN  Cloudflare API token (Workers Scripts:Edit) — used only if you
#                 are not already `wrangler login`'d
#   SITE_URL      override the Pages URL the worker redirects back to
#   WORKER_URL    skip URL auto-detection and use this exact Worker URL

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
APPDIR="$HERE/.app"
EXAMPLE="$HERE/wrangler.toml.example"
TOML="$HERE/wrangler.toml"          # generated (gitignored); copied from EXAMPLE
CONFIG="$REPO_ROOT/config.js"       # the one committed per-deploy frontend file

say() { printf '\n\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- preflight ------------------------------------------------------------
for tool in node openssl npx git; do
  command -v "$tool" >/dev/null || die "missing required tool: $tool"
done
[ -f "$EXAMPLE" ] || die "wrangler.toml.example not found at $EXAMPLE"

# ---- detect repo from git remote -----------------------------------------
remote="$(git -C "$REPO_ROOT" config --get remote.origin.url || true)"
[ -n "$remote" ] || die "no git 'origin' remote found in $REPO_ROOT"
slug="$(printf '%s' "$remote" \
  | sed -E 's#^git@github\.com:##; s#^ssh://git@github\.com/##; s#^https://github\.com/##; s#\.git$##')"
REPO_OWNER="${slug%%/*}"
REPO_NAME="${slug##*/}"
[ -n "$REPO_OWNER" ] && [ -n "$REPO_NAME" ] && [ "$REPO_OWNER" != "$slug" ] \
  || die "could not parse owner/repo from origin remote: $remote"

# user/org pages (owner.github.io) serve at the domain root; project pages at /<repo>.
owner_lc="$(printf '%s' "$REPO_OWNER" | tr '[:upper:]' '[:lower:]')"
repo_lc="$(printf '%s' "$REPO_NAME" | tr '[:upper:]' '[:lower:]')"
ORIGIN="https://${owner_lc}.github.io"
if [ "$repo_lc" = "${owner_lc}.github.io" ]; then
  SITE_URL_DEFAULT="$ORIGIN"
else
  SITE_URL_DEFAULT="$ORIGIN/$REPO_NAME"
fi
SITE_URL="${SITE_URL:-$SITE_URL_DEFAULT}"
ALLOWED_ORIGINS="$ORIGIN,http://localhost:8000"

# Who may count: the GitHub user RUNNING setup (the operator), NOT the repo owner.
# For an org-owned fork the owner is the org NAME, which can never match an
# individual login (OAuth always signs in a user, never an org). Fall back to the
# repo owner only if gh can't tell us who the operator is. Override with
# ALLOWED_LOGINS=... ("" = any signed-in user).
operator=""
if command -v gh >/dev/null; then
  operator="$(gh api user --jq .login 2>/dev/null || true)"
fi
ALLOWED_LOGINS="${ALLOWED_LOGINS:-${operator:-$REPO_OWNER}}"

# If the fork owner is a GitHub ORG, the App must be created UNDER that org — a
# personal App can't be installed on an org's repos. Detect and default ORG;
# override with ORG=... explicitly.
if [ -z "${ORG:-}" ] && command -v gh >/dev/null; then
  owner_type="$(gh api "users/$REPO_OWNER" --jq .type 2>/dev/null || true)"
  if [ "$owner_type" = "Organization" ]; then
    ORG="$REPO_OWNER"
  fi
fi

# Worker name: ALWAYS derive a fork-unique name from the repo. Do NOT inherit the
# `name` already in wrangler.toml — for a fork that's the UPSTREAM owner's worker
# name, and reusing it would OVERWRITE their Worker if you deploy to an account
# that already has it. Override with WORKER_NAME=... only if you mean to.
derived_name="tally-$(printf '%s' "$repo_lc" | tr -c 'a-z0-9-' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')"
WORKER_NAME="${WORKER_NAME:-$derived_name}"
APP_NAME="${APP_NAME:-$derived_name}"

say "Repo:    $REPO_OWNER/$REPO_NAME"
echo "Site:    $SITE_URL"
echo "Worker:  $WORKER_NAME"
echo "App:     $APP_NAME${ORG:+   (under org: $ORG)}"
echo "Allowed: $ALLOWED_LOGINS"

# ---- cloudflare auth ------------------------------------------------------
# wrangler uses CLOUDFLARE_API_TOKEN if set, else an interactive `wrangler login`
# session. Support both; prompt for a token only if neither is present.
if [ -n "${CF_API_TOKEN:-}" ]; then
  export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if ! npx --yes wrangler whoami >/dev/null 2>&1; then
    echo
    echo "Cloudflare isn't authenticated. Either run 'npx wrangler login' first,"
    echo "or paste an API token now (scope: Workers Scripts:Edit). Blank aborts."
    printf 'Cloudflare API token: '
    read -r -s CF_TOKEN_INPUT
    echo
    [ -n "$CF_TOKEN_INPUT" ] || die "no Cloudflare auth available"
    export CLOUDFLARE_API_TOKEN="$CF_TOKEN_INPUT"
  fi
fi

wrangler() { npx --yes wrangler "$@"; }

# ---- clean-tree bookkeeping ----------------------------------------------
# Remove disposable wrangler cache + the PKCS#8 temp always; keep .app only on
# failure (so a retry doesn't re-mint the App). On success the secrets live
# solely in Cloudflare, so .app is deleted.
DONE=0
cleanup() {
  rm -rf "$HERE/.wrangler" "$APPDIR/private-key-pkcs8.pem"
  if [ "$DONE" = "1" ]; then
    rm -rf "$APPDIR"
  elif [ -d "$APPDIR" ]; then
    echo "Note: partial credentials kept in $APPDIR (setup didn't finish)." >&2
    echo "Re-run to retry, or remove with: rm -rf \"$APPDIR\"" >&2
  fi
}
trap cleanup EXIT
cd "$HERE"

# Set a top-level `KEY = "VALUE"` in wrangler.toml (replace in place, or append).
set_toml() {
  local key="$1" val="$2"
  if grep -qE "^${key}[[:space:]]*=" "$TOML"; then
    sed -i -E "s|^${key}[[:space:]]*=.*|${key} = \"${val}\"|" "$TOML"
  else
    printf '%s = "%s"\n' "$key" "$val" >> "$TOML"
  fi
}

# ---- 1) write config ------------------------------------------------------
say "1/7  Writing wrangler.toml config for $REPO_OWNER/$REPO_NAME"
# wrangler.toml is a generated artifact (gitignored); seed it from the template.
[ -f "$TOML" ] || cp "$EXAMPLE" "$TOML"
set_toml name "$WORKER_NAME"
set_toml REPO_OWNER "$REPO_OWNER"
set_toml REPO_NAME "$REPO_NAME"
set_toml SITE_URL "$SITE_URL"
set_toml ALLOWED_LOGINS "$ALLOWED_LOGINS"
set_toml ALLOWED_ORIGINS "$ALLOWED_ORIGINS"

# ---- confirm the Cloudflare target before any deploy ----------------------
# Deploy goes to whatever account wrangler is authenticated to. Show it and the
# Worker name so a wrong account / name collision is caught BEFORE overwriting.
say "Confirm the Cloudflare target — the Worker will be created here:"
npx --yes wrangler whoami 2>&1 | sed -n '1,12p' || true
echo
echo "  Worker name : $WORKER_NAME"
echo "  For repo    : $REPO_OWNER/$REPO_NAME"
echo "If this is the WRONG Cloudflare account, abort, switch accounts"
echo "(npx wrangler logout && npx wrangler login, or set CF_API_TOKEN), and re-run."
if [ "${ASSUME_YES:-}" != "1" ]; then
  printf 'Deploy to this account? [y/N] '
  read -r ans
  case "$ans" in [yY] | [yY][eE][sS]) ;; *) die "aborted before deploy" ;; esac
fi

# ---- 2) first deploy to learn the Worker URL ------------------------------
if [ -z "${WORKER_URL:-}" ]; then
  say "2/7  Deploying the Worker once to discover its URL"
  deploy_out="$(wrangler deploy 2>&1 | tee /dev/stderr)" || die "wrangler deploy failed (see above)"
  WORKER_URL="$(printf '%s' "$deploy_out" | grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -1 || true)"
  if [ -z "$WORKER_URL" ]; then
    echo
    echo "Couldn't auto-detect the Worker URL from the deploy output."
    printf 'Paste your Worker URL (https://%s.<subdomain>.workers.dev): ' "$WORKER_NAME"
    read -r WORKER_URL
  fi
  [ -n "$WORKER_URL" ] || die "no Worker URL"
else
  say "2/7  Using provided WORKER_URL=$WORKER_URL (skipping discovery deploy)"
fi
CALLBACK_URL="$WORKER_URL/auth/callback"
echo "Worker URL: $WORKER_URL"

# ---- 3) create the GitHub App --------------------------------------------
say "3/7  Creating your GitHub App (a browser window opens — click 'Create')"
export APP_NAME CALLBACK_URL SITE_URL OWNER="$REPO_OWNER" REPO="$REPO_NAME"
export ORG="${ORG:-}"
node "$HERE/create-app.mjs"
# shellcheck disable=SC1091
source "$APPDIR/app.env"   # provides APP_ID, CLIENT_ID, APP_SLUG, INSTALL_URL

# ---- 4) convert key + write IDs ------------------------------------------
say "4/7  Converting the private key to PKCS#8 and writing the App IDs"
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in "$APPDIR/private-key.pem" -out "$APPDIR/private-key-pkcs8.pem"
set_toml GITHUB_APP_ID "$APP_ID"
set_toml GITHUB_CLIENT_ID "$CLIENT_ID"

# ---- 5) upload secrets ----------------------------------------------------
say "5/7  Uploading secrets to Cloudflare (piped from the App — nothing pasted)"
wrangler secret put GITHUB_APP_PRIVATE_KEY < "$APPDIR/private-key-pkcs8.pem"
wrangler secret put GITHUB_CLIENT_SECRET   < "$APPDIR/client-secret.txt"
openssl rand -base64 32 | wrangler secret put SESSION_SECRET

# ---- 6) redeploy + write the site's config (config.js, not app source) ----
say "6/7  Re-deploying the Worker and writing the site config (config.js)"
wrangler deploy
# config.js is the ONE deployment-specific frontend file. App source (tally.js)
# imports it, so the source stays identical across deployments. Pages must serve
# it, so it IS committed (unlike the gitignored wrangler.toml).
cat > "$CONFIG" <<EOF
// Deployment-specific frontend config — written by committer-proxy/setup.sh.
// Points the app at this deployment's Worker; tally.js imports it, so the app
// source is identical in every deployment.
export const WORKER_URL = "$WORKER_URL";
EOF
git -C "$REPO_ROOT" add -- "$CONFIG"
if git -C "$REPO_ROOT" diff --cached --quiet -- "$CONFIG"; then
  echo "config.js already current."
else
  git -C "$REPO_ROOT" commit -q -m "Point site at its Worker ($WORKER_NAME)"
  git -C "$REPO_ROOT" push || echo "(! couldn't push config.js — push manually when ready)"
fi

# ---- 7) enable Pages + Actions, optional email (Resend) secrets -----------
say "7/7  Finishing up"
if command -v gh >/dev/null; then
  if gh api -X PUT "repos/$REPO_OWNER/$REPO_NAME/actions/permissions" -F enabled=true >/dev/null 2>&1; then
    echo "Enabled Actions on the fork."
  else
    echo "(could not auto-enable Actions; do it in Settings → Actions)"
  fi
  if gh api -X POST "repos/$REPO_OWNER/$REPO_NAME/pages" -f 'source[branch]=main' -f 'source[path]=/' >/dev/null 2>&1; then
    echo "Enabled GitHub Pages (main / root)."
  else
    echo "(could not auto-enable Pages; do it in Settings → Pages)"
  fi

  # Secrets for the archive-email.yml workflow (Resend). Unlike the Worker's
  # secrets, these are GitHub *Actions* secrets and don't transfer on fork or
  # template — so set them here. Blank API key = skip the email feature.
  rk="${RESEND_API_KEY:-}"; ne="${NOTIFY_EMAIL:-}"; mf="${MAIL_FROM:-}"
  if [ -z "$rk" ]; then
    printf 'Optional Resend API key for email-on-archive (blank = skip): '
    read -r rk
  fi
  if [ -n "$rk" ]; then
    if printf '%s' "$rk" | gh secret set RESEND_API_KEY --repo "$REPO_OWNER/$REPO_NAME" >/dev/null 2>&1; then
      echo "Set RESEND_API_KEY."
    else
      echo "(failed to set RESEND_API_KEY — check repo admin, or set it manually)"
    fi
    if [ -z "$ne" ]; then printf '  Notify email (where to send): '; read -r ne; fi
    if [ -n "$ne" ]; then
      if printf '%s' "$ne" | gh secret set NOTIFY_EMAIL --repo "$REPO_OWNER/$REPO_NAME" >/dev/null 2>&1; then
        echo "Set NOTIFY_EMAIL."
      else
        echo "(failed to set NOTIFY_EMAIL)"
      fi
    else
      echo "(no NOTIFY_EMAIL — the email won't send until you set it)"
    fi
    if [ -z "$mf" ]; then printf '  From address [onboarding@resend.dev]: '; read -r mf; fi
    if [ -n "$mf" ]; then
      if printf '%s' "$mf" | gh secret set MAIL_FROM --repo "$REPO_OWNER/$REPO_NAME" >/dev/null 2>&1; then
        echo "Set MAIL_FROM."
      else
        echo "(failed to set MAIL_FROM)"
      fi
    fi
  else
    echo "Skipped email secrets. Add later: gh secret set RESEND_API_KEY --repo $REPO_OWNER/$REPO_NAME"
  fi
else
  echo "Install 'gh' to auto-enable Pages/Actions + set email secrets, or by hand:"
  echo "  • Settings → Actions → enable workflows on this fork"
  echo "  • Settings → Pages → deploy from main / (root)"
  echo "  • Settings → Secrets → Actions: RESEND_API_KEY, NOTIFY_EMAIL (for archive-email.yml)"
fi

DONE=1
cat <<EOF

✅ Done.
   GitHub App:  $APP_SLUG  (id $APP_ID)
   Worker:      $WORKER_URL
   Site:        $SITE_URL

ONE manual step left — install the App on your repo (one click):
   $INSTALL_URL

Then open $SITE_URL, sign in with GitHub, and start tallying.
The App's secrets live only in Cloudflare; local copies were removed.
EOF
