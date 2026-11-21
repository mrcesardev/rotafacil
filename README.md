# 🚚 RotaFácil

Roteirizador de entregas para operadores com **vários entregadores**, sem APIs pagas.
O operador recebe as localizações dos clientes no WhatsApp, cola no sistema, e o RotaFácil
divide as entregas entre os entregadores e monta a melhor ordem de cada rota. A meta é
menos quilômetros, menos tempo e menos combustível.

## Como funciona

1. **Configurar a base.** É o ponto de onde os entregadores saem: um link, coordenadas ou um clique no mapa.
2. **Cadastrar os entregadores.** Marque quem trabalha no dia e, se quiser, o máximo de paradas de cada um.
3. **Colar as localizações do WhatsApp**, uma por linha. O sistema entende:
   - localização fixa compartilhada ou exportada (`localização: https://maps.google.com/?q=...`);
   - links do Google Maps, longos ou curtos (`maps.app.goo.gl`), Waze, Apple Maps, OpenStreetMap e `geo:`;
   - coordenadas soltas (`-23.5505, -46.6333`);
   - endereço em texto (geocodificado pelo OpenStreetMap; confira o pino no mapa).

   O texto antes do link vira o nome do cliente (`Maria - https://...`). Os pinos podem ser **arrastados** para corrigir o local.
4. **Gerar as rotas.** O otimizador divide as entregas entre os entregadores, agrupando por região, e define a ordem de cada rota com o horário previsto de chegada.
5. **Enviar a rota no WhatsApp.** Cada entregador recebe um link próprio (não precisa de login) com o mapa, a lista na ordem, botões para abrir **Google Maps ou Waze** na próxima parada e para marcar **Entregue / Não entregue**. O operador acompanha o andamento pelo painel.

### Modo equilibrado
Ligado (padrão): cada entregador fica entre 75% e 125% da divisão igual.
Desligado: o otimizador minimiza a distância total, e pode deixar algum entregador com poucas paradas.

## Rodando localmente (modo simples)

Requer Node.js 22.13+.

```bash
npm install
npm start            # http://localhost:3000
npm test
```

Sem nenhum serviço extra, o sistema usa o **otimizador embutido** com **distâncias estimadas**
(linha reta × fator de desvio urbano). Serve para testar e para operações pequenas.

## Produção: ruas reais (OSRM) + otimizador VROOM

```bash
cp .env.example .env
./scripts/prepare-osrm.sh sudeste     # norte | nordeste | centro-oeste | sudeste | sul | brasil
docker compose up -d
```

- **OSRM** calcula tempos e distâncias pelas ruas do OpenStreetMap e desenha a rota no mapa.
- **VROOM** é o otimizador de rotas open source usado em produção por várias empresas.
- Se algum dos dois cair, o app volta sozinho para o modo simples.

**Servidor:** uma região (ex.: Sudeste) roda bem num VPS de 4 a 8 GB de RAM. O Brasil inteiro precisa
de cerca de 16 GB durante a preparação. Atualize o mapa de tempos em tempos rodando o script de novo.

### Atenção em produção
- **Tiles do mapa:** o servidor público do OpenStreetMap não permite uso comercial intenso. Configure
  `TILE_URL` com um provedor (MapTiler, Stadia, Protomaps…) ou hospede os seus.
- **Geocodificação de endereços:** o Nominatim público limita a 1 requisição/s. Para volume, hospede
  o seu e configure `NOMINATIM_URL`. Localizações fixas e links não usam geocodificação.
- Use HTTPS (`NODE_ENV=production` liga o cookie `Secure`).

## WhatsApp automático (API oficial da Meta)

Com a **WhatsApp Cloud API**, as localizações chegam sozinhas como entregas do dia:

1. Crie um app na Meta for Developers e ative o WhatsApp.
2. No `.env`: `WHATSAPP_VERIFY_TOKEN` (um texto qualquer) e `WHATSAPP_APP_SECRET` (segredo do app).
3. Configure o webhook: `https://SEU-DOMINIO/webhooks/whatsapp` (campo `messages`).
4. No painel do RotaFácil, em ⚙️ Configurar, informe o `phone_number_id` do seu número.

As mensagens do tipo **localização** viram entregas com o nome do contato. Mensagens de texto com link
também são aproveitadas. Bibliotecas não oficiais (Baileys etc.) não são usadas porque o número pode ser banido.

## Estrutura

```
src/
  server.js            API (Express) + webhook do WhatsApp
  db.js                SQLite (node:sqlite, sem dependência nativa)
  auth.js              contas de operador e sessões
  location.js          leitura de links/coordenadas/endereços do WhatsApp
  routing/matrix.js    matriz de tempos/distâncias (OSRM ou estimativa)
  routing/heuristic.js otimizador embutido (inserção regret + busca local)
  routing/optimizer.js escolhe VROOM ou embutido, calcula horários
public/                painel do operador e página do entregador (Leaflet)
test/                  testes (node --test)
```

## Próximos passos sugeridos
- Janelas de horário por entrega ("só depois das 14h") e prioridade.
- Re-roteirizar a partir da posição atual do entregador no meio do dia.
- Capacidade por volume/peso, perfis moto × carro.
- Planos e cobrança (assinatura) para virar SaaS aberto.
- Histórico e relatórios (km rodados, entregas por entregador, falhas).
