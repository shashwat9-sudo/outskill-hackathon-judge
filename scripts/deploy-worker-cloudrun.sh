#!/usr/bin/env bash
#
# Deploy the judging worker to Cloud Run.
#
# Cloud Run rather than Vercel because judging is not a serverless workload: a
# real Chromium drives a participant's product for minutes and writes a trace as
# it goes. Vercel cannot host that; a container host can.
#
# Deployed as a **worker pool**, not a request-handling service: nothing calls
# the worker over HTTP. It leases jobs from Postgres, so it needs to keep
# running with no traffic, which is what `--no-cpu-throttling` and a minimum
# instance count buy. A scale-to-zero service would stop leasing the moment the
# last request finished, which is to say immediately, because there are none.
#
# Secrets are read from Secret Manager at start-up. None is passed on this
# command line, so none appears in shell history, in `gcloud` logs, or in the
# Cloud Run revision description.
#
# Prerequisites, all of which need the operator's own Google account:
#   gcloud auth login
#   gcloud config set project <PROJECT_ID>
#   gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
#                          cloudbuild.googleapis.com secretmanager.googleapis.com
#
# Usage:  ./scripts/deploy-worker-cloudrun.sh <PROJECT_ID> [REGION]

set -euo pipefail

PROJECT="${1:-}"
REGION="${2:-asia-south1}"
SERVICE="ohj-judging-worker"
REPO="ohj"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/worker"

[ -n "$PROJECT" ] || { echo "Usage: $0 <PROJECT_ID> [REGION]"; exit 1; }
command -v gcloud >/dev/null || { echo "gcloud is not installed. See docs/WORKER_DEPLOYMENT.md."; exit 1; }

# Mumbai by default: the database is in ap-south-1 and the judged products are
# mostly Indian-hosted. A worker in us-central1 pays that latency on every one
# of the dozens of queries a single assessment makes.
echo "Project ${PROJECT}, region ${REGION}"

# ---- 1. Somewhere to put the image ----------------------------------------
gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker --location "$REGION" --project "$PROJECT" \
    --description="Outskill Hackathon Judge images"

# ---- 2. Build it there, not here -------------------------------------------
# Cloud Build, so no local Docker is needed and the image is built on the same
# architecture it will run on. A worker image built on an arm64 laptop will not
# start on an amd64 Cloud Run instance.
gcloud builds submit --project "$PROJECT" --region "$REGION" \
  --tag "$IMAGE" --file apps/worker/Dockerfile .

# ---- 3. Run it -------------------------------------------------------------
#
# `--no-cpu-throttling` is load-bearing. Without it Cloud Run parks the CPU
# between requests, and a worker that receives no requests would be parked
# permanently — holding a lease it cannot make progress on until it expires.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" \
  --no-allow-unauthenticated \
  --min-instances=1 --max-instances=3 \
  --cpu=2 --memory=4Gi \
  --no-cpu-throttling \
  --timeout=3600 \
  --set-env-vars="NODE_ENV=production,DEMO_MODE=0,AI_EVALUATION_MODE=synthetic_only,BROWSER_HEADLESS=true,WORKER_CONCURRENCY=2,WORKER_HEALTH_PORT=8080" \
  --set-secrets="DATABASE_URL=ohj-database-url:latest,SUPABASE_URL=ohj-supabase-url:latest,SUPABASE_SECRET_KEY=ohj-supabase-secret-key:latest,CREDENTIAL_ENCRYPTION_KEY=ohj-credential-key:latest,ADMIN_SESSION_SECRET=ohj-session-secret:latest,AI_API_KEY=ohj-ai-api-key:latest,AI_PROVIDER=ohj-ai-provider:latest"

echo
echo "Deployed. It takes no traffic — check it is alive with:"
echo "  gcloud run services logs read $SERVICE --project $PROJECT --region $REGION --limit 50"
