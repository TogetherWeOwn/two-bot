# Container image for the TWO bot (TOG-13).
#
# The bot deploys to the owner's existing VPS, which already runs Coolify, so
# the unit of deployment is an image rather than the systemd units in deploy/.
# Those units are NOT dead - they remain the right answer for a plain host, and
# docs/DEPLOY.md says which is which. What changes in a container:
#
#   - The token is an environment variable again, not a systemd credential.
#     LoadCredential has no container equivalent, and the isolation argument it
#     was making (a co-tenant web user cannot read the file) is made by the
#     container boundary instead. src/core/credentials.ts already falls back to
#     the environment, so no code changes.
#   - Health is an HTTP probe rather than `systemctl status`, which is why
#     src/core/health.ts exists.
#
# Node 24 runs TypeScript directly - no build step, no tsc, no dist/. That is
# why there is no builder stage here: there is nothing to compile.

# Pinned by digest (TOG-8680) so rebuilds do not drift when the rolling tag
# moves. A pin that is never refreshed goes stale silently, so this comment
# is the refresh record: update the digest AND the date below together.
#
# Digest refreshed: 2026-09-28 (TOG-9126; live tag digest verified identical
# the same day, tag last pushed 2026-09-19 — the pin was already current, so
# this refresh changed the record, not the digest).
# Cadence: monthly. scripts/ci/check-docker-digest-age.sh fails red when the
# recorded date is older than 35 days (see docs/DEPLOY.md §9). Refresh with:
#   crane digest node:24-bookworm-slim   (or Docker Hub API digest lookup)
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# Unprivileged from the start. The base image ships uid/gid 1000 as `node`.
# Nothing in this image needs root at runtime, and the internal actions endpoint
# binds 8787 while health binds 8080 - both above 1024, so no capability is
# needed to listen. This mirrors CapabilityBoundingSet= in deploy/two-bot.service.
ENV NODE_ENV=production \
    TWO_HEALTH_PORT=8080

WORKDIR /app

# Dependencies first, as their own layer: package.json changes far less often
# than src/, so a code-only deploy reuses this layer and skips the install.
# `npm ci` needs the lockfile, and --omit=dev drops typescript and @types/*,
# which are build-time only - nothing in src/ imports them at runtime.
#
# --ignore-scripts: the repo's `prepare` hook installs git hooks, which needs a
# .git directory this image does not have and must not want. Without this the
# install fails or silently depends on the build context carrying .git.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Then the application. Ordered after the install so it invalidates nothing above.
COPY --chown=node:node src/ ./src/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node migrations/ ./migrations/
COPY --chown=node:node sql/ ./sql/
COPY --chown=node:node tsconfig.json ./

USER node

# Documentation only - publishing is Coolify's business, and neither port should
# be exposed to the internet. 8787 in particular is a remote control for the
# Discord server and src/internal/bind.ts refuses to start it on a public
# address. See docs/INTERNAL_ACTIONS.md §1.
EXPOSE 8080

# Coolify reads this, and so does `docker ps`. /healthz not /readyz on purpose:
# HEALTHCHECK failure restarts the container, and restarting a bot that is
# merely still connecting to the gateway is how an identify-budget crash loop
# starts. Readiness is for the platform's deploy gate, liveness is for restarts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TWO_HEALTH_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No npm in the runtime path: npm forks a shell that does not forward SIGTERM,
# so `npm start` would leave index.ts' shutdown handler never running and the
# database closed by the 10s kill instead. node is PID 1 and gets the signal.
CMD ["node", "src/index.ts"]
