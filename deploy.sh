#!/usr/bin/env bash
# gw-mailbox — Interactive Deployment Wizard
#
# Works both inside a cloned repository and standalone in an empty directory:
#   mkdir -p gw-mailbox && cd gw-mailbox
#   curl -fsSL https://raw.githubusercontent.com/wannaco/gw-mailbox/main/deploy.sh -o deploy.sh
#   bash deploy.sh
set -euo pipefail

REPO_RAW="${MAILBOX_REPO_RAW:-https://raw.githubusercontent.com/wannaco/gw-mailbox/main}"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}$*${NC}"; }
ok()    { echo -e "${GREEN}✓ $*${NC}"; }
warn()  { echo -e "${YELLOW}! $*${NC}"; }
fail()  { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

prompt() {
  local msg="$1" default="${2:-}" val=""
  if [ -n "$default" ]; then
    read -r -p "$msg [$default]: " val </dev/tty
    echo "${val:-$default}"
  else
    read -r -p "$msg: " val </dev/tty
    echo "$val"
  fi
}

prompt_secret() {
  local msg="$1" val=""
  read -r -s -p "$msg: " val </dev/tty
  echo "" >&2
  echo "$val"
}

gen_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ]; then
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  else
    fail "Cannot generate PB_ENCRYPTION_KEY (neither openssl nor /dev/urandom available)."
  fi
}

fetch_if_missing() {
  local rel="$1"
  if [ -f "$rel" ]; then
    return 0
  fi
  command -v curl >/dev/null 2>&1 || fail "Missing $rel and curl is not installed."
  mkdir -p "$(dirname "$rel")"
  info "Downloading $rel..."
  curl -fsSL "$REPO_RAW/$rel" -o "$rel" || fail "Failed to download $REPO_RAW/$rel"
}

# ── 1. Check Docker & Compose ──
echo -e "${BOLD}gw-mailbox — Deployment Wizard${NC}"
echo "================================"
echo ""

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker is not installed."
  if command -v curl >/dev/null 2>&1; then
    INSTALL_DOCKER=$(prompt "Install Docker now using get.docker.com? (y/N)" "N")
    if [[ "$INSTALL_DOCKER" =~ ^[Yy]$ ]]; then
      curl -fsSL https://get.docker.com | sudo sh || fail "Docker installation failed."
      ok "Docker installed"
    else
      fail "Install Docker first: https://docs.docker.com/get-docker/"
    fi
  else
    fail "Docker is not installed. Install Docker first: https://docs.docker.com/get-docker/"
  fi
fi

install_compose_plugin() {
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    if sudo apt-get install -y docker-compose-plugin 2>/dev/null || sudo apt-get install -y docker-compose-v2 2>/dev/null; then
      return 0
    fi
  elif command -v dnf >/dev/null 2>&1; then
    if sudo dnf install -y docker-compose-plugin 2>/dev/null; then return 0; fi
  elif command -v yum >/dev/null 2>&1; then
    if sudo yum install -y docker-compose-plugin 2>/dev/null; then return 0; fi
  elif command -v zypper >/dev/null 2>&1; then
    if sudo zypper install -y docker-compose 2>/dev/null; then return 0; fi
  elif command -v pacman >/dev/null 2>&1; then
    if sudo pacman -Sy --noconfirm docker-compose 2>/dev/null; then return 0; fi
  elif command -v apk >/dev/null 2>&1; then
    if sudo apk add --no-cache docker-cli-compose 2>/dev/null; then return 0; fi
  elif command -v brew >/dev/null 2>&1; then
    if brew install docker-compose; then return 0; fi
  fi

  # Universal fallback: install the official Docker Compose v2 CLI plugin binary on Linux
  if [ "$(uname -s)" = "Linux" ] && command -v curl >/dev/null 2>&1; then
    local arch
    arch=$(uname -m)
    info "Installing Docker Compose v2 CLI plugin for Linux ($arch)..."
    sudo mkdir -p /usr/local/lib/docker/cli-plugins
    sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose || return 1
    sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    return 0
  fi
  return 1
}

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  warn "Docker Compose plugin is not installed."
  INSTALL_COMPOSE=$(prompt "Install Docker Compose plugin now? (Y/n)" "Y")
  if [[ "$INSTALL_COMPOSE" =~ ^[Yy]$ ]]; then
    install_compose_plugin || fail "Could not install Docker Compose automatically. Install 'docker-compose-plugin' and re-run."
    if docker compose version >/dev/null 2>&1; then
      COMPOSE=(docker compose)
      ok "Docker Compose installed"
    elif command -v docker-compose >/dev/null 2>&1; then
      COMPOSE=(docker-compose)
      ok "Docker Compose installed"
    else
      fail "Docker Compose still not found after install."
    fi
  else
    fail "Docker Compose is required. Install 'docker-compose-plugin' and re-run."
  fi
fi

docker info >/dev/null 2>&1 || fail "Docker daemon is not running or current user lacks permission (try adding user to 'docker' group or running with sudo)."

# ── 2. Choose deployment mode ──
echo "Select how you want to run gw-mailbox:"
echo "  1) Production server (VPS) — bundled Caddy with automatic HTTPS (recommended)"
echo "  2) Behind existing reverse proxy — Traefik, Coolify, Dokploy, Nginx"
echo "  3) Local machine only — http://127.0.0.1:8090 (no domain, no TLS)"
echo ""
MODE=$(prompt "Choice (1-3)" "1")

case "$MODE" in
  1)
    COMPOSE_FILE="docker-compose.yml"
    fetch_if_missing "docker-compose.yml"
    fetch_if_missing "Caddyfile"
    ;;
  2)
    COMPOSE_FILE="docker-compose.traefik.yml"
    fetch_if_missing "docker-compose.traefik.yml"
    ;;
  3)
    COMPOSE_FILE="docker-compose.dev.yml"
    fetch_if_missing "docker-compose.dev.yml"
    ;;
  *)
    fail "Invalid choice: $MODE"
    ;;
esac

# ── 3. Configure .env (modes 1 and 2) ──
DOMAIN=""
MAILBOX_PUBLIC_URL=""
PB_ENCRYPTION_KEY=""
WRITE_ENV=true

if [ "$MODE" = "3" ]; then
  WRITE_ENV=false
elif [ -f ".env" ]; then
  echo ""
  warn "An existing .env file was found."
  KEEP=$(prompt "Keep existing .env (preserves your PB_ENCRYPTION_KEY)? (Y/n)" "Y")
  if [[ "$KEEP" =~ ^[Yy]$ ]]; then
    WRITE_ENV=false
    # shellcheck disable=SC1091
    set -a; source .env; set +a
  fi
fi

if [ "$WRITE_ENV" = true ]; then
  echo ""
  if [ "$MODE" = "1" ]; then
    while [ -z "$DOMAIN" ]; do
      DOMAIN=$(prompt "Domain name pointing to this server (e.g. mailbox.example.com)")
      [ -n "$DOMAIN" ] || warn "Domain is required for automatic HTTPS."
    done
    MAILBOX_PUBLIC_URL="https://${DOMAIN}"
  elif [ "$MODE" = "2" ]; then
    while [ -z "$MAILBOX_PUBLIC_URL" ]; do
      MAILBOX_PUBLIC_URL=$(prompt "Public URL for OAuth2 and CSAT links (e.g. https://mailbox.example.com)")
      [ -n "$MAILBOX_PUBLIC_URL" ] || warn "Public URL is required."
    done
  fi

  echo ""
  echo "PB_ENCRYPTION_KEY encrypts sensitive data in PocketBase."
  EXISTING_KEY=$(prompt "Paste an existing PB_ENCRYPTION_KEY, or press Enter to generate a new one" "")
  if [ -n "$EXISTING_KEY" ]; then
    PB_ENCRYPTION_KEY="$EXISTING_KEY"
  else
    PB_ENCRYPTION_KEY=$(gen_key)
    echo ""
    echo -e "${YELLOW}┌──────────────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${YELLOW}│ SAVE THIS PB_ENCRYPTION_KEY IN YOUR PASSWORD MANAGER NOW!            │${NC}"
    echo -e "${YELLOW}│ Losing or changing it later will make stored values unreadable.      │${NC}"
    echo -e "${YELLOW}│                                                                      │${NC}"
    echo -e "${YELLOW}│ PB_ENCRYPTION_KEY=${BOLD}${PB_ENCRYPTION_KEY}${NC}${YELLOW} │${NC}"
    echo -e "${YELLOW}└──────────────────────────────────────────────────────────────────────┘${NC}"
    echo ""
    read -r -p "Press Enter once you have saved it..." </dev/tty
  fi

  echo ""
  SETUP_PB=$(prompt "Create PocketBase /_/ superuser account automatically? (y/N)" "N")
  MAILBOX_ADMIN_EMAIL=""
  MAILBOX_ADMIN_PASSWORD=""
  if [[ "$SETUP_PB" =~ ^[Yy]$ ]]; then
    MAILBOX_ADMIN_EMAIL=$(prompt "PocketBase superuser email")
    while [ ${#MAILBOX_ADMIN_PASSWORD} -lt 8 ]; do
      MAILBOX_ADMIN_PASSWORD=$(prompt_secret "PocketBase superuser password (8+ chars)")
      [ ${#MAILBOX_ADMIN_PASSWORD} -ge 8 ] || warn "Password must be at least 8 characters."
    done
  fi

  echo ""
  MAILBOX_TIMEZONE=$(prompt "Calendar/UI timezone" "UTC")

  umask 077
  cat > .env <<EOF
# Generated by deploy.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
DOMAIN=${DOMAIN}
MAILBOX_PUBLIC_URL=${MAILBOX_PUBLIC_URL}
PB_ENCRYPTION_KEY=${PB_ENCRYPTION_KEY}
MAILBOX_ADMIN_EMAIL=${MAILBOX_ADMIN_EMAIL}
MAILBOX_ADMIN_PASSWORD=${MAILBOX_ADMIN_PASSWORD}
MAILBOX_POLL_SYNC=1
MAILBOX_SEED_DEMO=0
MAILBOX_TIMEZONE=${MAILBOX_TIMEZONE}
MAILBOX_ALLOWED_ORIGIN=
EOF
  ok "Wrote .env (permissions 600)"
fi

# ── 4. Launch stack ──
echo ""
info "Starting gw-mailbox using $COMPOSE_FILE..."
"${COMPOSE[@]}" -f "$COMPOSE_FILE" up -d

echo ""
ok "gw-mailbox is starting!"
case "$MODE" in
  1)
    echo "  • App URL:  https://${DOMAIN}"
    echo "  • Note:     Ensure DNS for ${DOMAIN} points here and ports 80/443 are open."
    ;;
  2)
    echo "  • Proxy target: http://app:8090 (on the compose network)"
    echo "  • Public URL:   ${MAILBOX_PUBLIC_URL}"
    ;;
  3)
    echo "  • App URL:  http://127.0.0.1:8090"
    ;;
esac
echo "  • Logs:     ${COMPOSE[*]} -f $COMPOSE_FILE logs -f"
echo "  • Update:   ${COMPOSE[*]} -f $COMPOSE_FILE up -d"
