#!/usr/bin/env bash
# Configura a VPS da montagem Vercel + Supabase + VPS (veja DEPLOY-VERCEL-SUPABASE.md).
# Rode dentro da pasta do projeto, como root:
#
#   sudo ./scripts/setup-vps.sh
#
# Ou sem perguntas (o certificado do Supabase já em certs/supabase-ca.crt):
#   sudo API_DOMAIN=api.seudominio.com.br ACME_EMAIL=voce@email.com \
#        DATABASE_URL='postgresql://...' MAPTILER_KEY=xxxx ./scripts/setup-vps.sh
#
# O que faz: instala Docker, ativa o firewall, cria swap se a memória for pouca,
# grava o .env e o certificado do Supabase, testa a conexão com o banco, prepara
# o mapa e sobe API + OSRM + VROOM + backup. Pode ser rodado de novo sem estragar nada.
set -euo pipefail

cd "$(dirname "$0")/.."
REGION="${REGION:-centro-oeste}"
COMPOSE=(docker compose -f docker-compose.vps.yml)
CA=certs/supabase-ca.crt
say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[atenção] %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[erro] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Rode como root: sudo $0"
grep -qi ubuntu /etc/os-release || warn "Testado em Ubuntu; em outra distribuição pode precisar de ajustes."

# ---------- Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  say "Instalando Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null || die "docker compose não encontrado"

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

mkdir -p certs backups

# ---------- certificado SSL do Supabase ----------
if [ ! -s "$CA" ]; then
  say "Certificado SSL do Supabase"
  echo "No Supabase: Database > Settings > SSL Configuration > baixar o certificado."
  echo "Abra o arquivo .crt num editor de texto, copie TODO o conteúdo e cole aqui."
  echo "(termina sozinho na linha -----END CERTIFICATE-----)"
  : > "$CA.tmp"
  while IFS= read -r line; do
    printf '%s\n' "$line" >> "$CA.tmp"
    case "$line" in *"-----END CERTIFICATE-----"*) break ;; esac
  done
  grep -q 'BEGIN CERTIFICATE' "$CA.tmp" || { rm -f "$CA.tmp"; die "Isso não parece um certificado. Rode o script de novo."; }
  mv "$CA.tmp" "$CA"
fi
openssl x509 -in "$CA" -noout 2>/dev/null || die "$CA não é um certificado válido. Apague o arquivo e rode de novo."
chmod 644 "$CA"

# ---------- .env ----------
check_db_url() {
  local u="$1"
  [[ "$u" =~ ^postgres(ql)?:// ]] || { echo "A URL deve começar com postgresql://"; return 1; }
  [[ "$u" == *"'"* ]] && { echo "A URL não pode ter aspas simples"; return 1; }
  [[ "$u" == *sslmode=* ]] && { echo "Tire o ?sslmode=... da URL (o SSL usa o certificado)"; return 1; }
  [[ "$u" == *:6543/* ]] && { echo "Essa é a URL do Transaction pooler (6543). Use a do Session pooler (5432)"; return 1; }
  [[ "$u" =~ @db\.[a-z0-9]+\.supabase\.co ]] && warn "Essa é a Direct connection (só IPv6). Se a conexão falhar, use a do Session pooler."
  return 0
}

if [ ! -f .env ]; then
  say "Criando .env"
  while [ -z "${API_DOMAIN:-}" ]; do read -rp "Domínio da API (ex.: api.seudominio.com.br): " API_DOMAIN; done
  while ! printf '%s' "${ACME_EMAIL:-}" | grep -qE '^[^@ ]+@[^@ ]+\.[^@ ]+$'; do
    read -rp "Seu e-mail (avisos do certificado HTTPS): " ACME_EMAIL
  done
  until [ -n "${DATABASE_URL:-}" ] && check_db_url "$DATABASE_URL"; do
    read -rsp "URL do Session pooler do Supabase (não aparece ao digitar): " DATABASE_URL; echo
  done
  [ -n "${MAPTILER_KEY+x}" ] || read -rp "Chave da MapTiler (Enter para pular): " MAPTILER_KEY
  {
    echo "# gerado por setup-vps.sh em $(date -I)"
    echo "API_DOMAIN=${API_DOMAIN}"
    echo "ACME_EMAIL=${ACME_EMAIL}"
    echo "DATABASE_URL='${DATABASE_URL}'"
    echo "BACKUP_KEEP_DAYS=14"
    if [ -n "${MAPTILER_KEY:-}" ]; then
      echo "TILE_URL='https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=${MAPTILER_KEY}'"
      echo "TILE_ATTRIBUTION='&copy; MapTiler &copy; colaboradores do OpenStreetMap'"
      echo "SATELLITE_TILE_URL='https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}'"
      echo "SATELLITE_ATTRIBUTION='&copy; MapTiler'"
    fi
  } > .env
  chmod 600 .env
else
  say ".env já existe: mantendo"
fi
# lê só o que precisa do .env, sem executá-lo
env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed "s/^'\(.*\)'$/\1/"; }
API_DOMAIN=$(env_get API_DOMAIN)
DATABASE_URL=$(env_get DATABASE_URL)
[ -n "$API_DOMAIN" ] && [ -n "$DATABASE_URL" ] || die "O .env precisa de API_DOMAIN e DATABASE_URL"
check_db_url "$DATABASE_URL" || die "Corrija DATABASE_URL no .env"

# ---------- teste do banco ----------
say "Testando a conexão com o Supabase (SSL verificado)"
if ! docker run --rm -v "$PWD/certs:/certs:ro" -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/certs/supabase-ca.crt \
     -e PGCONNECT_TIMEOUT=15 postgres:17-alpine psql "$DATABASE_URL" -tAc 'select 1' >/dev/null; then
  die "Não conectou ao Supabase. Confira a URL e a senha (DATABASE_URL no .env) e o certificado ($CA). Veja DEPLOY-VERCEL-SUPABASE.md, seção 8."
fi
echo "Conexão OK."

# ---------- DNS ----------
DNS_IP=$(getent ahostsv4 "$API_DOMAIN" | awk 'NR==1 {print $1}' || true)
if [ -z "$DNS_IP" ]; then
  warn "$API_DOMAIN ainda não aponta para nenhum IP. Crie o registro A (seção 3 do guia). O HTTPS só funciona depois disso."
elif ! hostname -I | tr ' ' '\n' | grep -qx "$DNS_IP"; then
  PUB_IP=$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || true)
  [ "$DNS_IP" = "$PUB_IP" ] || warn "$API_DOMAIN aponta para $DNS_IP, que não parece ser este servidor (${PUB_IP:-IP desconhecido})."
fi

# ---------- mapa ----------
if [ ! -f osrm-data/region.osrm.mldgr ]; then
  say "Preparando o mapa ($REGION). Pode levar de 10 a 40 minutos."
  ./scripts/prepare-osrm.sh "$REGION"
else
  say "Mapa já preparado: mantendo (para atualizar: ./scripts/prepare-osrm.sh $REGION)"
fi

# ---------- subir ----------
say "Subindo os serviços"
"${COMPOSE[@]}" up -d --build

say "Aguardando a API ficar pronta"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    if curl -fsS --max-time 10 "https://$API_DOMAIN/api/health" >/dev/null 2>&1; then
      say "Pronto! A API responde em https://$API_DOMAIN"
    else
      warn "A API está no ar, mas https://$API_DOMAIN ainda não responde (DNS ou certificado). Veja: ${COMPOSE[*]} logs caddy"
    fi
    echo
    echo "Na Vercel, crie a variável de ambiente:"
    echo "  API_ORIGIN=https://$API_DOMAIN"
    exit 0
  fi
  sleep 5
done
die "A API não respondeu a tempo. Veja os logs: ${COMPOSE[*]} logs app"
