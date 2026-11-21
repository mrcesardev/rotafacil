# 🚚 RotaFácil

Roteirizador de entregas para operadores com **vários entregadores**, sem APIs pagas.
O operador recebe as localizações dos clientes no WhatsApp, cola no sistema, e o RotaFácil
divide as entregas entre os entregadores e monta a melhor ordem de cada rota. A meta é
menos quilômetros, menos tempo e menos combustível.

## Como funciona

O operador decide **quais entregas vão com cada entregador**. O sistema calcula a
**melhor ordem de cada rota, saindo do ponto onde aquele entregador está**.

1. **Cadastrar os entregadores.**
2. **Definir onde cada entregador está** (📍 Partida): cole a localização que ele mandou no WhatsApp
   ou marque no mapa. Se não houver, a rota sai da *base padrão* (opcional, em ⚙️ Configurar).
3. **Colar as localizações dos clientes**, uma por linha, já escolhendo o entregador ("Entregar com"),
   ou deixando sem entregador para distribuir depois. O sistema entende:
   - localização fixa compartilhada ou exportada (`localização: https://maps.google.com/?q=...`);
   - links do Google Maps, longos ou curtos (`maps.app.goo.gl`), Waze, Apple Maps, OpenStreetMap e `geo:`;
   - coordenadas soltas (`-23.5505, -46.6333`);
   - endereço em texto (geocodificado pelo OpenStreetMap; confira o pino no mapa).

   O texto antes do link vira o nome do cliente (`Maria - https://...`). Os pinos podem ser **arrastados** para corrigir o local.
4. **Distribuir:** troque o entregador de cada entrega pelo seletor, ou marque várias e clique em **Atribuir**.
5. **Gerar as rotas:**
   - **individual:** botão "Gerar rota" no card do entregador;
   - **todos:** "Gerar rotas de todos". Cada rota sai da posição do seu entregador.
6. **Enviar a rota no WhatsApp.** Cada entregador recebe um link próprio (não precisa de login) com o mapa,
   a ordem das paradas, a previsão de chegada, atalhos para **Google Maps / Waze**, e os botões
   **Entregue / Não entregue**. O link continua o mesmo quando a rota é recalculada.
7. **No meio do dia**, o entregador toca em **"Recalcular a partir de onde estou"**. O celular manda a posição
   do GPS e as paradas pendentes são reordenadas a partir dali. As já feitas mantêm a numeração.

## Link do destinatário (o cliente marca onde quer receber)

Em vez de pedir a localização pelo WhatsApp, o operador pode mandar um **link único da entrega**:

1. No painel, em **"Pedir localização ao cliente"**, informe o nome (ou nº do pedido) e o WhatsApp do cliente
   e clique em **Criar link**. Para uma entrega que já existe, use o botão 🔗 na lista.
2. Clique em **Enviar no WhatsApp**. A mensagem já vai pronta com o link.
3. O cliente abre no celular e marca o local:
   - botão **"Usar minha localização atual"** (GPS), busca por endereço, ou toque no mapa;
   - arrasta o pino até a entrada certa;
   - escreve a referência ("apto 32, portão azul") e aceita o uso dos dados (LGPD).
4. No painel, a entrega passa de **⏳ aguardando cliente** para **✅ confirmado pelo cliente** sozinha
   (atualiza a cada 30 s). A referência aparece também para o entregador.
5. **Pelo mesmo link, o cliente acompanha a entrega:**
   - quando a rota é gerada: *"Saiu para entrega com Carlos · faltam 2 entregas antes da sua · previsão ≈ 14:20"*;
   - depois: *"Entregue às 14:23"*, ou *"Não conseguimos entregar"*.

Regras de segurança:
- o link só existe se o operador criou a entrega, e o token é aleatório (não dá para adivinhar);
- o cliente não vê observações internas nem as outras paradas da rota;
- depois que a encomenda sai para entrega, o cliente não consegue mais mudar o local;
- há limite de tentativas por IP.

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
- Use HTTPS (`NODE_ENV=production` liga o cookie `Secure`). Sem HTTPS, o botão de GPS (entregador e cliente) não funciona.
- Atrás de proxy reverso (Caddy/Nginx), defina `TRUST_PROXY=1` para o limite por IP usar o IP real do cliente.
- **Satélite (opcional):** com `SATELLITE_TILE_URL`, os mapas ganham a opção "Satélite". Ela ajuda o cliente a achar a própria casa.

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
  recipient.js         área pública do destinatário (marcar local e acompanhar)
  routing/matrix.js    matriz de tempos/distâncias (OSRM ou estimativa)
  routing/heuristic.js otimizador embutido da ordem das paradas (inserção + 2-opt/or-opt)
  routing/optimizer.js escolhe VROOM ou embutido, calcula horários
public/                painel do operador, página do entregador e do destinatário (Leaflet)
test/                  testes (node --test)
```

## Próximos passos sugeridos
- Janelas de horário por entrega ("só depois das 14h") e prioridade.
- Sugestão automática de distribuição (opcional) para quando o operador quiser ajuda.
- Perfis moto × carro (velocidades diferentes).
- Planos e cobrança (assinatura) para virar SaaS aberto.
- Histórico e relatórios (km rodados, entregas por entregador, falhas).
