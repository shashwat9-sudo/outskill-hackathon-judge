# The judging worker.
#
# Not a serverless workload and not a candidate for one: every submission gets a
# real Chromium, driven for minutes, with a trace and screenshots written as it
# goes. It needs a machine with a browser on it and time to use it.
#
# Based on Playwright's own image because the browser and the system libraries
# it needs are already there and already matched to the client version. Building
# that pairing by hand is how you get a worker that runs locally and cannot
# launch a browser in production.

# Pinned to the Playwright version in package-lock.json. These two must move
# together — a client newer than its browsers fails at launch, with a message
# about a missing executable rather than about the mismatch.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production
# The browsers are in the image already. Without this, npm install downloads a
# second copy on every build.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Manifests first, so a change to source code does not reinstall the world.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ai/package.json packages/ai/
COPY apps/worker/package.json apps/worker/

# The web app is not part of this image. It is deployed separately and its
# dependencies — Next, React, Tailwind — have no business on a judging machine.
RUN npm ci --workspace=@ohj/worker --include-workspace-root

COPY packages/shared packages/shared
COPY packages/ai packages/ai
COPY apps/worker apps/worker

# Run as the image's unprivileged user. A browser rendering somebody else's
# product is the last process that should be root.
USER pwuser

# Cloud Run sends SIGTERM and waits. The worker finishes the job it holds and
# releases its lease rather than letting it expire, so a redeploy does not
# strand work for the length of the lease.
STOPSIGNAL SIGTERM

# Liveness at /healthz, readiness at /readyz, on WORKER_HEALTH_PORT. The
# distinction matters here: a worker inside a browser run is busy, not stalled,
# and a readiness probe that cannot tell the difference will restart a machine
# in the middle of judging somebody's submission.
EXPOSE 8080

CMD ["npm", "run", "start", "--workspace=@ohj/worker"]
