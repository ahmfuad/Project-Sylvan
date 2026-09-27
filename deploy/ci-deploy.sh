#!/usr/bin/env bash
#
# Project Sylvan — non-interactive deploy, run by GitHub Actions (.github/workflows/ci-cd.yml).
#
# Installed on the VPS as /usr/local/bin/sylvan-deploy and bound to the CI deploy key through a
# forced command in /root/.ssh/authorized_keys:
#   command="/usr/local/bin/sylvan-deploy",restrict ssh-ed25519 AAAA... sylvan-github-actions
# so the key can only ever run this script. The commit SHA to deploy arrives as the SSH command
# (SSH_ORIGINAL_COMMAND), or as $1 when run by hand:  sudo sylvan-deploy <40-char sha>
#
# Assumes the first-time setup from deploy/deploy.sh is done (.env, nginx site, TLS). Steps:
#   1. Fetch main and check out the requested commit (it must be on main).
#   2. Reinstall this script if the commit changed it, and re-run the new version.
#   3. Build the dashboard into web/dist.new (the live web/dist is untouched until the end).
#   4. Rebuild and restart the backend with Docker Compose; wait for /api/health.
#   5. Swap web/dist.new into place.
# The database volume and data/photos are never touched.
set -euo pipefail

DEPLOY_DIR="/opt/sylvan"
REPO_URL="https://github.com/ahmfuad/Project-Sylvan.git"
BRANCH="main"
APP_PORT=3100
INSTALL_PATH="/usr/local/bin/sylvan-deploy"

log() { printf '\n==> %s\n' "$1"; }
die() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root."

# One deploy at a time: a second push while one is running fails fast instead of interleaving.
exec 9>/var/lock/sylvan-deploy.lock
flock -n 9 || die "Another deploy is already running."

SHA="${1:-${SSH_ORIGINAL_COMMAND:-}}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "Expected a full 40-character commit SHA, got: '${SHA}'"

# ---- 1. Code --------------------------------------------------------------------------------------
log "Fetching $BRANCH and checking out ${SHA:0:7}"
cd "$DEPLOY_DIR"
git remote set-url origin "$REPO_URL"
git fetch --quiet origin "$BRANCH"
git merge-base --is-ancestor "$SHA" "origin/$BRANCH" || die "${SHA:0:7} is not on origin/$BRANCH."
PREVIOUS="$(git rev-parse HEAD)"
git reset --quiet --hard "$SHA"
echo "Was ${PREVIOUS:0:7}, now ${SHA:0:7}: $(git log -1 --format=%s)"

# ---- 2. Self-update -------------------------------------------------------------------------------
if [ -z "${SYLVAN_DEPLOY_REEXEC:-}" ] && ! cmp -s deploy/ci-deploy.sh "$INSTALL_PATH"; then
  log "deploy/ci-deploy.sh changed; installing the new version and re-running it"
  install -m 755 deploy/ci-deploy.sh "$INSTALL_PATH"
  exec 9>&-
  SYLVAN_DEPLOY_REEXEC=1 exec "$INSTALL_PATH" "$SHA"
fi

# ---- 3. Dashboard (built aside, swapped in after the backend is healthy) --------------------------
log "Building the dashboard"
rm -rf web/dist.new
docker run --rm \
  -v "$DEPLOY_DIR":/app -w /app \
  -v sylvan-npm-cache:/tmp/.npm \
  -e HOME=/tmp \
  -e SYLVAN_COMMIT="$SHA" \
  node:22-alpine \
  sh -c "npm ci --include-workspace-root --workspace shared --workspace web --ignore-scripts --no-audit --no-fund && \
         npm run build -w shared && npm run build -w web -- --outDir dist.new --emptyOutDir"
[ -f web/dist.new/index.html ] || die "web/dist.new/index.html was not produced."

# ---- 4. Backend -----------------------------------------------------------------------------------
log "Rebuilding and restarting the backend"
mkdir -p data/photos
chown -R 1000:1000 data/photos
docker compose up -d --build

echo -n "Waiting for /api/health"
healthy=""
for _ in $(seq 1 45); do
  if curl -sf "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
    healthy=1
    echo " — up."
    break
  fi
  echo -n "."
  sleep 2
done
if [ -z "$healthy" ]; then
  echo
  docker compose logs --tail 80 app || true
  rm -rf web/dist.new
  die "The API did not become healthy. The previous dashboard is still being served."
fi

# ---- 5. Swap the dashboard in ---------------------------------------------------------------------
log "Publishing the dashboard"
rm -rf web/dist.old
[ -d web/dist ] && mv web/dist web/dist.old
mv web/dist.new web/dist
rm -rf web/dist.old

docker image prune -f >/dev/null   # dangling layers left by the rebuild

log "Deployed ${SHA:0:7}"
