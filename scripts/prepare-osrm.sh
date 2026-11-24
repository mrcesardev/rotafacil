#!/usr/bin/env bash
# Baixa o mapa do OpenStreetMap da região e prepara os dados do OSRM (perfil carro).
#
# Uso: ./scripts/prepare-osrm.sh <região>
#   Regiões do Brasil na Geofabrik: norte, nordeste, centro-oeste, sudeste, sul
#   ou "brasil" para o país inteiro (precisa de ~16 GB de RAM na preparação).
#   Também aceita uma URL .osm.pbf qualquer.
#
# Para usar perfil de moto/bicicleta, troque car.lua por bicycle.lua (ou um perfil customizado).
set -euo pipefail

REGION="${1:-centro-oeste}"
OSRM_IMAGE="ghcr.io/project-osrm/osrm-backend:v5.27.1"
DIR="$(cd "$(dirname "$0")/.." && pwd)/osrm-data"
mkdir -p "$DIR"

case "$REGION" in
  http*) URL="$REGION" ;;
  brasil|brazil) URL="https://download.geofabrik.de/south-america/brazil-latest.osm.pbf" ;;
  norte|nordeste|centro-oeste|sudeste|sul) URL="https://download.geofabrik.de/south-america/brazil/${REGION}-latest.osm.pbf" ;;
  *) echo "Região desconhecida: $REGION"; exit 1 ;;
esac

echo "==> Baixando $URL"
curl -fL --retry 3 -o "$DIR/region.osm.pbf" "$URL"

echo "==> Extraindo malha viária (pode levar de 5 a 40 minutos)"
docker run --rm -t -v "$DIR:/data" "$OSRM_IMAGE" osrm-extract -p /opt/car.lua /data/region.osm.pbf
docker run --rm -t -v "$DIR:/data" "$OSRM_IMAGE" osrm-partition /data/region.osrm
docker run --rm -t -v "$DIR:/data" "$OSRM_IMAGE" osrm-customize /data/region.osrm

echo "==> Pronto. Agora rode: docker compose up -d"
