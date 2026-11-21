#!/usr/bin/env bash
# Instala o RotaFácil numa VPS Ubuntu (22.04 ou 24.04) recém-criada.
# Rode dentro da pasta do projeto, como root (ou com sudo):
#
#   sudo ./scripts/setup-server.sh
#
# Ou sem perguntas:
#   sudo DOMAIN=rotas.seudominio.com.br ACME_EMAIL=voce@email.com MAPTILER_KEY=xxxx ./scripts/setup-server.sh
#
# O que faz: instala Docker, ativa o firewall, cria swap se a memória for pouca,
# gera o .env com senha forte, prepara o mapa do Centro-Oeste e sobe tudo.
# Pode ser rodado de novo sem estragar nada.
set -euo pipefail

cd "$(dirname "$0")/.."
REGION="${REGION:-centro-oeste}"
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[atenção] %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then echo "Rode como root: sudo $0"; exit 1; fi
if ! grep -qi ubuntu /etc/os-release; then warn "Testado em Ubuntu; em outra distribuição pode precisar de ajustes."; fi

# ---------- Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  say "Instalando Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null

# ---------- firewall ----------
if command -v ufw >/dev/null 2>&1; then
  say "Firewall: liberando SSH, HTTP e HTTPS"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
fi

# ---------- swap (a preparação do mapa usa bastante memória) ----------
MEM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
if [ "$MEM_GB" -lt 8 ] && ! swapon --show | grep -q .; then
  say "Memória de ${MEM_GB} GB: criando 4 GB de swap"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------- .env ----------
if [ ! -f .env ]; then
  say "Criando .env"
  [ -n "${DOMAIN:-}" ] || read -rp "Domínio (ex.: rotas.seudominio.com.br): " DOMAIN
  while ! printf '%s' "${ACME_EMAIL:-}" | grep -qE '^[^@ ]+@[^@ ]+\.[^@ ]+$'; do
    read -rp "Seu e-mail (avisos do certificado HTTPS): " ACME_EMAIL
  done
  while [ -z "${DOMAIN:-}" ]; do read -rp "Domínio (ex.: rotas.seudominio.com.br): " DOMAIN; done
  [ -n "${MAPTILER_KEY+x}" ] || read -rp "Chave da MapTiler (Enter para pular): " MAPTILER_KEY
  {
    echo "# gerado por setup-server.sh em $(date -I)"
    echo "DOMAIN=${DOMAIN}"
    echo "ACME_EMAIL=${ACME_EMAIL}"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "BACKUP_KEEP_DAYS=14"
    if [ -n "${MAPTILER_KEY:-}" ]; then
      echo "TILE_URL=https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=${MAPTILER_KEY}"
      echo "TILE_ATTRIBUTION=&copy; MapTiler &copy; colaboradores do OpenStreetMap"
      echo "SATELLITE_TILE_URL=https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}"
      echo "SATELLITE_ATTRIBUTION=&copy; MapTiler"
    fi
  } > .env
  chmod 600 .env
else
  say ".env já existe: mantendo"
fi
# lê só o que precisa do .env, sem executá-lo (valores podem ter &, ; etc.)
DOMAIN=$(grep -E '^DOMAIN=' .env | tail -1 | cut -d= -f2-)

# ---------- DNS ----------
if [ -n "${DOMAIN:-}" ] && [ "$DOMAIN" != "localhost" ]; then
  DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}' || true)
  if [ -z "$DNS_IP" ]; then
    warn "O domínio $DOMAIN ainda não aponta para nenhum IP. Crie o registro A (veja DEPLOY.md). O HTTPS só funciona depois disso."
  elif ! hostname -I | tr ' ' '\n' | grep -qx "$DNS_IP"; then
    warn "$DOMAIN aponta para $DNS_IP, que não parece ser deste servidor ($(hostname -I | awk '{print $1}')). Confira o registro A."
  fi
fi

# ---------- mapa ----------
if [ ! -f osrm-data/region.osrm.mldgr ]; then
  say "Preparando o mapa ($REGION). Pode levar de 10 a 40 minutos."
  ./scripts/prepare-osrm.sh "$REGION"
else
  say "Mapa já preparado: mantendo (para atualizar: ./scripts/prepare-osrm.sh $REGION)"
fi

# ---------- subir ----------
mkdir -p backups
say "Subindo os serviços"
docker compose up -d --build

say "Aguardando o app ficar pronto"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    say "Pronto! Acesse: https://${DOMAIN:-localhost}"
    echo "Crie a conta da empresa na tela inicial (a primeira pessoa vira a dona da conta)."
    exit 0
  fi
  sleep 5
done
warn "O app não respondeu a tempo. Veja os logs: docker compose logs app"
exit 1
