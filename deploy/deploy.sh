#!/usr/bin/env bash
#
# Project Sylvan — deploy / update script for the production VPS.
#
# What it does, every time you run it:
#   1. Clones the repo on first run, or pulls the latest `main` on every run after.
#   2. Creates .env on first run only (generates DEVICE_KEY/DB_PASSWORD, or use your own —
#      see EXISTING_DEVICE_KEY below). Never touches an existing .env.
#   3. Builds the backend image and starts it + Postgres via Docker Compose
#      (127.0.0.1:3100 only, no published database port — nginx is the public entry point).
#   4. Builds the dashboard (web/dist) inside a throwaway Node container, so nothing needs
#      installing on the host besides Docker.
#   5. Writes an nginx site config to deploy/nginx-sylvan.conf — but does NOT enable it, so it
#      never touches your other ~13 sites without you reviewing it first. Prints the exact
#      commands to enable it and to get a TLS certificate with certbot.
#
# Usage (as root, or with sudo), from anywhere on the server:
#   sudo bash deploy.sh
#
# Safe to re-run: it is the same command for the first deploy and for every later update.
set -euo pipefail

# ---------------------------------------------------------------------------------------------
# Configuration — edit these if your setup differs.
# ---------------------------------------------------------------------------------------------
DOMAIN="sylvan.daftar-e.com"
REPO_URL="https://github.com/ahmfuad/Project-Sylvan.git"
BRANCH="main"
DEPLOY_DIR="/opt/sylvan"
APP_PORT=3100
# Paste an existing DEVICE_KEY here to reuse a key already flashed to the rover, e.g.:
#   EXISTING_DEVICE_KEY="1a1d90c2cf7067469742d7172e33e5a1dbc330889fe1ee2f666dcb3b9f0a2484"
# Leave empty to generate a fresh one on first deploy (printed once at the end).
EXISTING_DEVICE_KEY=""
# ---------------------------------------------------------------------------------------------

log()  { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# ---- Preflight -------------------------------------------------------------------------------
log "Checking prerequisites"

[ "$(id -u)" -eq 0 ] || die "Run this as root (sudo bash deploy.sh) — it writes to $DEPLOY_DIR and /etc/nginx."
command -v git >/dev/null || die "git is not installed. Try: apt install -y git"
command -v openssl >/dev/null || die "openssl is not installed. Try: apt install -y openssl"
command -v docker >/dev/null || die "Docker is not installed."
docker compose version >/dev/null 2>&1 || die "The 'docker compose' plugin (v2) is required (not the old standalone docker-compose)."
command -v nginx >/dev/null || warn "nginx was not found on PATH. The generated config will still be written, but you'll need nginx installed to use it (apt install -y nginx)."
command -v certbot >/dev/null || warn "certbot was not found. Install it before running the certbot command printed at the end (apt install -y certbot python3-certbot-nginx)."

# ---- 1. Get the code --------------------------------------------------------------------------
log "Fetching the code (branch: $BRANCH)"

if [ -d "$DEPLOY_DIR/.git" ]; then
  git -C "$DEPLOY_DIR" fetch origin "$BRANCH"
  git -C "$DEPLOY_DIR" reset --hard "origin/$BRANCH"
  echo "Updated $DEPLOY_DIR to the latest $BRANCH ($(git -C "$DEPLOY_DIR" rev-parse --short HEAD))."
else
  mkdir -p "$(dirname "$DEPLOY_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$DEPLOY_DIR"
  echo "Cloned into $DEPLOY_DIR ($(git -C "$DEPLOY_DIR" rev-parse --short HEAD))."
fi
cd "$DEPLOY_DIR"

# git reset --hard only touches tracked files; .env, .env.local and data/ are gitignored and
# untracked, so a redeploy never overwrites your secrets or the rover's photos.

# ---- 2. Configuration (.env) -------------------------------------------------------------------
log "Checking configuration"

if [ -f .env ]; then
  echo ".env already exists — leaving it untouched. Delete it first if you want it regenerated."
else
  echo "No .env found: creating one for this deployment."
  DEVICE_KEY="${EXISTING_DEVICE_KEY:-$(openssl rand -hex 32)}"
  DB_PASSWORD="$(openssl rand -hex 16)"

  cp .env.example .env
  # Portable in-place sed (works the same on GNU/BSD since we always write to a temp file).
  set_env() {
    local key="$1" value="$2"
    if grep -q "^${key}=" .env; then
      sed -i.bak "s#^${key}=.*#${key}=${value}#" .env && rm -f .env.bak
    else
      printf '%s=%s\n' "$key" "$value" >> .env
    fi
  }
  set_env NODE_ENV production
  set_env DEVICE_KEY "$DEVICE_KEY"
  set_env DB_PASSWORD "$DB_PASSWORD"
  set_env DATABASE_URL "postgres://sylvan:${DB_PASSWORD}@db:5432/sylvan"
  set_env PUBLIC_BASE_URL "https://${DOMAIN}"
  # nginx serves photos directly in production (see the generated nginx config below).
  set_env SERVE_PHOTOS false
  # The app only trusts X-Forwarded-* from these addresses: nginx on the loopback interface, and
  # the Docker bridge gateway nginx actually connects through via the published port (this
  # network is pinned in docker-compose.yml precisely so this address never changes).
  set_env TRUST_PROXY "127.0.0.1,::1,172.28.90.1"

  chmod 600 .env
  echo "Generated .env with a fresh DEVICE_KEY and DB_PASSWORD."
  GENERATED_DEVICE_KEY="$DEVICE_KEY"
fi

mkdir -p data/photos
chown -R 1000:1000 data/photos   # the app container runs as uid 1000 (node), not root

# ---- 3. Backend: build and start ---------------------------------------------------------------
log "Building and starting the backend (Postgres + API)"

docker compose up -d --build

echo -n "Waiting for the API to become healthy"
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
    echo " — up."
    break
  fi
  echo -n "."
  sleep 2
done
if ! curl -sf "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
  warn "The API did not become healthy in time. Check: docker compose -f $DEPLOY_DIR/docker-compose.yml logs app"
fi

# ---- 4. Frontend: build the dashboard -----------------------------------------------------------
log "Building the dashboard (web/dist)"

# Built inside a throwaway container so the host never needs Node installed — kept isolated from
# whatever the other sites on this VPS run.
docker run --rm \
  -v "$DEPLOY_DIR":/app -w /app \
  -e HOME=/tmp \
  node:22-alpine \
  sh -c "npm ci --include-workspace-root --workspace shared --workspace web --ignore-scripts && \
         npm run build -w shared && npm run build -w web"

[ -f web/dist/index.html ] || die "web/dist/index.html was not produced — the frontend build failed."
echo "Dashboard built at $DEPLOY_DIR/web/dist"

# ---- 5. nginx site config (generated, not enabled) -----------------------------------------------
log "Writing the nginx site config"

mkdir -p deploy
CSP="default-src 'self'; base-uri 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"

cat > deploy/nginx-sylvan.conf <<NGINX
# Project Sylvan — nginx site config for ${DOMAIN}
# Generated by deploy/deploy.sh — review before enabling (see the printed instructions).
# certbot will add the TLS server block and the HTTP->HTTPS redirect automatically the first
# time you run: certbot --nginx -d ${DOMAIN}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # Matches server/src/app.ts's helmet config; this app.ts only sets these headers on its own
    # JSON/CSV responses, never on what nginx serves directly (this HTML/JS/CSS, and photos).
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Content-Security-Policy "${CSP}" always;
    # HSTS: nginx is the TLS termination point, so this is the only place it can be set correctly.
    # Only takes effect once the site is served over HTTPS (after certbot runs).
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

    # Uploaded photos: served directly, not proxied through Node.
    location /photos/ {
        alias ${DEPLOY_DIR}/data/photos/;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    # API: proxied to the app container, published on the loopback interface only.
    location /api/ {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # A little above MAX_PHOTO_BYTES (.env, default 500000) so nginx never rejects an upload
        # the app would otherwise accept. Raise this if MAX_PHOTO_BYTES is raised.
        client_max_body_size 1m;
    }

    # WebSockets: device heartbeat/frames and the public live-view channel.
    location /ws/ {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;   # longer than the 20s device/viewer ping interval
        proxy_send_timeout 300s;
        proxy_buffering off;       # frames must not be buffered by nginx
    }

    # The dashboard (React Router — unknown paths fall back to index.html).
    root ${DEPLOY_DIR}/web/dist;
    index index.html;
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    access_log /var/log/nginx/${DOMAIN}.access.log;
    error_log  /var/log/nginx/${DOMAIN}.error.log;
}
NGINX

echo "Written to $DEPLOY_DIR/deploy/nginx-sylvan.conf"

# ---- Summary -------------------------------------------------------------------------------------
log "Backend is up. Next steps (manual, on purpose — this box serves other live sites):"

cat <<STEPS

1) Review the generated config, then enable it:
     sudo cp $DEPLOY_DIR/deploy/nginx-sylvan.conf /etc/nginx/sites-available/${DOMAIN}
     sudo ln -s /etc/nginx/sites-available/${DOMAIN} /etc/nginx/sites-enabled/${DOMAIN}
     sudo nginx -t && sudo systemctl reload nginx

   (If this server uses a different layout than sites-available/sites-enabled — e.g. conf.d only —
   copy nginx-sylvan.conf into that location instead.)

2) Confirm DNS for ${DOMAIN} points at this server, then check it over plain HTTP:
     curl -I http://${DOMAIN}/api/health

3) Get a TLS certificate (only works once step 1 is live):
     sudo certbot --nginx -d ${DOMAIN}

4) Flash / update the rover firmware with the device key below, if it isn't already using it.

STEPS

if [ -n "${GENERATED_DEVICE_KEY:-}" ]; then
  echo "Generated DEVICE_KEY (save this now — shown only this once):"
  echo "  $GENERATED_DEVICE_KEY"
  echo
fi

cat <<SEED
Optional — load demo data instead of waiting for the real rover (the production image has no
dev tools installed, so this runs in its own throwaway container on the same Docker network):
  docker run --rm --network sylvan_default \\
    -v $DEPLOY_DIR:/app -w /app -e HOME=/tmp \\
    --env-file $DEPLOY_DIR/.env -e DATABASE_URL=postgres://sylvan:\$(grep ^DB_PASSWORD= $DEPLOY_DIR/.env | cut -d= -f2)@db:5432/sylvan \\
    -e PHOTO_DIR=/app/data/photos -e SEED_CONFIRM=yes \\
    node:22-alpine sh -c "npm ci --ignore-scripts && npm run build -w shared && npx tsx server/scripts/seed.ts"
SEED

log "Done."
