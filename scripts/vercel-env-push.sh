#!/usr/bin/env bash
#
# Push the environment a deployed web app needs, without a secret ever being
# displayed, pasted, or logged.
#
# Values are read from .env.local and piped straight into `vercel env add` on
# standard input. Nothing is echoed. The only output is the name of each
# variable and whether it was set.
#
# What is deliberately NOT pushed:
#
#   AI_API_KEY            The web app never calls a model — judging is the
#                         worker's job, and the worker is not deployed. A key
#                         that is not there cannot be misused or leaked.
#   ADMIN_SEED_USERNAME   The admin account already exists in the database.
#   ADMIN_SEED_PASSWORD   Sending its password to a hosting provider's
#                         environment would create a second copy of a
#                         credential that currently has one.
#   APP_BASE_URL          Not knowable until the deployment has a URL. Set
#                         afterwards, deliberately, in a second pass.
#
# Usage:  ./scripts/vercel-env-push.sh [environment]      (default: production)

set -euo pipefail

TARGET="${1:-production}"
ENV_FILE=".env.local"

[ -f "$ENV_FILE" ] || { echo "Run this from the repository root — $ENV_FILE not found."; exit 1; }

# Read one key's value out of .env.local without printing it.
value_of() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | head -1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

set_var() {
  local key="$1" value="$2"
  if [ -z "$value" ]; then
    echo "  ✗ $key — absent from $ENV_FILE, skipped"
    return
  fi
  # Remove any previous value first: `vercel env add` appends rather than
  # replaces, and two values for one key is a coin toss at build time.
  npx vercel env rm "$key" "$TARGET" --yes >/dev/null 2>&1 || true
  printf '%s' "$value" | npx vercel env add "$key" "$TARGET" >/dev/null 2>&1
  echo "  ✓ $key"
}

echo
echo "Pushing environment to Vercel ($TARGET). No value is printed."
echo

# --- Copied from .env.local, because they must match what the database holds ---
#
# CREDENTIAL_ENCRYPTION_KEY especially: demo credentials already stored are
# encrypted with this exact key. A different one there would not fail loudly —
# it would fail at the moment a judge tries to read a team's login.
for key in ADMIN_SESSION_SECRET CREDENTIAL_ENCRYPTION_KEY DATABASE_URL SUPABASE_URL SUPABASE_SECRET_KEY; do
  set_var "$key" "$(value_of "$key")"
done

# --- Fixed for a deployed web app ---
set_var DEMO_MODE "0"
# One connection per instance. Serverless multiplies instances, not pools, and
# the pooler is what handles the fan-in.
set_var DATABASE_POOL_MAX "1"
# No model, no key, no possibility of a call.
set_var AI_PROVIDER "demo"
# Held until real learner processing is separately approved.
set_var AI_EVALUATION_MODE "synthetic_only"

echo
echo "Done. APP_BASE_URL is intentionally not set yet — it is set once the"
echo "deployment has a URL, by scripts/vercel-set-base-url.sh."
echo
