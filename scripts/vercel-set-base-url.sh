#!/usr/bin/env bash
#
# Set APP_BASE_URL to the address the deployment actually has.
#
# Separate from the rest of the environment because it cannot be known before
# the first deploy, and because getting it wrong is expensive in a specific way:
# it is printed on every access-code sheet, and codes are one-time. A sheet with
# the wrong address on it costs a full rotation to undo.
#
# Refuses anything that is not HTTPS, and anything local.
#
# Usage:  ./scripts/vercel-set-base-url.sh https://your-app.vercel.app [environment]

set -euo pipefail

URL="${1:-}"
TARGET="${2:-production}"

[ -n "$URL" ] || { echo "Usage: $0 https://your-deployment-url [environment]"; exit 1; }

case "$URL" in
  https://*) ;;
  *) echo "Refusing: APP_BASE_URL must be https://. Got: $URL"; exit 1 ;;
esac

case "$URL" in
  *localhost*|*127.0.0.1*|*0.0.0.0*|*.invalid*|*.local*)
    echo "Refusing: \"$URL\" only works on one machine. Learners cannot reach it."; exit 1 ;;
esac

# No trailing slash: it is concatenated with paths, and "//submit" is a
# different URL to some proxies.
URL="${URL%/}"

npx vercel env rm APP_BASE_URL "$TARGET" --yes >/dev/null 2>&1 || true
printf '%s' "$URL" | npx vercel env add APP_BASE_URL "$TARGET" >/dev/null 2>&1

echo "  ✓ APP_BASE_URL set to $URL ($TARGET)"
echo
echo "Redeploy for it to take effect: npx vercel deploy --prod"
