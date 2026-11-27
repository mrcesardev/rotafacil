# Colocando o RotaFácil no ar com Vercel + Supabase + VPS

Nesta montagem cada serviço faz uma parte:

```
celular / navegador
        │  https://rotas.suaempresa.com.br
        ▼
   ┌─────────┐   /api/*, /webhooks/*   ┌──────────────────────── VPS Ubuntu ─────────────────────┐
   │ Vercel  │ ──────────────────────► │ Caddy (HTTPS) ─► API (Node) ─► OSRM (ruas)              │
   │ páginas │  api.suaempresa.com.br  │                      │      └─► VROOM (otimizador)      │
   └─────────┘                         │                      │   backup diário ─┐               │
                                       └──────────────────────┼──────────────────┼───────────────┘
                                                              ▼                  ▼
                                                        ┌──────────────────────────┐
                                                        │ Supabase (PostgreSQL)    │
                                                        └──────────────────────────┘
```

- **Vercel:** publica as páginas (painel, relatórios, entregador e cliente) e repassa as chamadas da API
  para a VPS **pelo mesmo domínio**. O navegador só enxerga `rotas.suaempresa.com.br`, então o login
  por cookie funciona sem configuração extra.
- **VPS:** roda a API, o OSRM e o VROOM. O OSRM e o VROOM não ficam expostos na internet.
- **Supabase:** guarda o banco. As migrações rodam sozinhas quando a API inicia.

Se você vai subir tudo num servidor só, sem Vercel nem Supabase, siga o [DEPLOY.md](DEPLOY.md).

## 1. O que providenciar

| Item | Recomendação | Observação |
|---|---|---|
| **Domínio** | `.com.br` no [registro.br](https://registro.br) | Você vai usar dois subdomínios: `rotas.` (Vercel) e `api.` (VPS) |
| **Supabase** | Projeto na região **South America (São Paulo)** | O plano gratuito pausa o projeto depois de 7 dias sem uso e não tem backup para baixar. Para operar de verdade, use o Pro |
| **Vercel** | Conta ligada ao GitHub | O plano Hobby (gratuito) é só para uso **não comercial**. Para a empresa, use o Pro |
| **VPS** | Ubuntu **24.04**, **4 vCPU, 8 GB de RAM, 80 GB SSD**, datacenter **no Brasil** | Sem o banco, ela fica com a API, o OSRM e o VROOM. Funciona com 4 GB (o script cria swap), mas a preparação do mapa fica lenta |
| **Mapa (tiles)** | Conta gratuita na [MapTiler](https://www.maptiler.com) | O servidor público do OpenStreetMap não permite uso comercial |

## 2. Supabase

1. Crie o projeto na região **São Paulo** e guarde a **senha do banco**.
2. Em **Connect**, copie a URL do **Session pooler**. Ela tem este formato:
   `postgresql://postgres.<ref-do-projeto>:<SENHA>@<host-do-pooler>:5432/postgres`
   - Use o **Session pooler**, não o *Transaction pooler* (porta 6543). As migrações usam uma trava
     que só funciona em modo sessão.
   - A *Direct connection* só funciona por IPv6. Muitas VPS não têm IPv6, e o Session pooler funciona por IPv4.
   - Se a senha tiver caracteres especiais (`@`, `#`, `/`…), troque-os pela forma codificada na URL
     (ex.: `@` vira `%40`), ou gere uma senha só com letras e números.
   - **Não** acrescente `?sslmode=...` à URL. O SSL é configurado pelo certificado (passo seguinte).
3. Em **Database → Settings → SSL Configuration**, baixe o **certificado SSL** (arquivo `.crt`).
   Com ele, a VPS confere que está falando com o Supabase de verdade. Se essa opção existir, ative também **Enforce SSL**.
4. **Data API:** o RotaFácil não usa a API REST automática do Supabase. A migração
   `003_supabase_lockdown.sql` já bloqueia o acesso dela a todas as tabelas (RLS ligado e permissões
   de `anon`/`authenticated` removidas). Como proteção extra, desligue a Data API nas configurações do projeto.

> **Regra para o futuro:** toda tabela nova criada numa migração deve vir com
> `ALTER TABLE nome ENABLE ROW LEVEL SECURITY;`. Sem isso, ela fica visível pela API REST do Supabase.

## 3. DNS

No painel de DNS do domínio, crie:

| Tipo | Nome | Valor |
|---|---|---|
| `A` | `api` | IP da VPS |
| `CNAME` | `rotas` | o valor que a Vercel mostrar no passo 5 (geralmente `cname.vercel-dns.com`) |

## 4. VPS

Acesse o servidor (`ssh root@IP_DA_VPS`). O repositório é privado, então crie uma *deploy key*
como no [DEPLOY.md, passo 3](DEPLOY.md#3-copiar-o-projeto-para-o-servidor). Depois:

```bash
apt-get update && apt-get install -y git
git clone git@github.com:mrcesardev/rotafacil.git /opt/rotafacil
cd /opt/rotafacil
sudo ./scripts/setup-vps.sh
```

O script pergunta:
- o **domínio da API**;
- o **e-mail**;
- a **URL do Session pooler** (não aparece na tela enquanto você digita);
- a **chave da MapTiler**;
- o **certificado do Supabase**: abra o `.crt` num editor de texto, copie tudo e cole no terminal.

Depois ele faz o resto sozinho:
- instala o Docker;
- ativa o firewall;
- cria swap se faltar memória;
- testa a conexão com o Supabase antes de continuar;
- prepara o mapa (de 10 a 40 minutos);
- sobe tudo.

No fim, mostra o valor de `API_ORIGIN` para usar na Vercel.
Se algo der errado, corrija e rode o script de novo: ele aproveita o que já foi feito.

<details>
<summary>Fazer à mão, sem o script</summary>

```bash
# Docker e firewall (só SSH, HTTP e HTTPS)
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable

# projeto
git clone git@github.com:mrcesardev/rotafacil.git /opt/rotafacil
cd /opt/rotafacil

# certificado do Supabase (copie do seu computador com:
#   scp prod-ca-2021.crt root@IP_DA_VPS:/opt/rotafacil/certs/supabase-ca.crt )
mkdir -p certs backups
```

Crie o arquivo `.env` (`nano .env`) com o conteúdo abaixo, trocando os valores:

```bash
API_DOMAIN=api.suaempresa.com.br
ACME_EMAIL=voce@suaempresa.com.br
DATABASE_URL=postgresql://postgres.<ref>:<SENHA>@<host-do-pooler>:5432/postgres
BACKUP_KEEP_DAYS=14
TILE_URL=https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=SUA_CHAVE
TILE_ATTRIBUTION=&copy; MapTiler &copy; colaboradores do OpenStreetMap
SATELLITE_TILE_URL=https://api.maptiler.com/maps/satellite/256/{z}/{x}/{y}.jpg?key=SUA_CHAVE
SATELLITE_ATTRIBUTION=&copy; MapTiler
```

Proteja o arquivo, prepare o mapa (de 10 a 40 minutos) e suba os serviços:

```bash
chmod 600 .env
./scripts/prepare-osrm.sh centro-oeste
docker compose -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.vps.yml logs -f app     # deve mostrar as migrações e "rodando"
```

Teste do seu computador: `https://api.suaempresa.com.br/api/health` deve responder `{"ok":true}`.

> Com 4 GB de RAM, crie swap antes de preparar o mapa:
> `fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`

</details>

## 5. Vercel

1. **Add New → Project** e importe o repositório `rotafacil`.
2. Em **Framework Preset**, deixe **Other**. Os comandos de build já vêm do `vercel.json`.
3. Em **Environment Variables**, crie `API_ORIGIN` = `https://api.suaempresa.com.br` (sem barra no final).
4. Clique em **Deploy**.
5. Em **Settings → Domains**, adicione `rotas.suaempresa.com.br` e crie no DNS o registro que a Vercel indicar.

Pronto: abra `https://rotas.suaempresa.com.br` e crie a conta da empresa. A primeira pessoa vira a dona.
Depois siga o [DEPLOY.md, passo 5](DEPLOY.md#5-primeiro-acesso) (fuso horário, base, equipe).

Cada `git push` na branch principal publica as páginas de novo na Vercel. A API na VPS é atualizada à parte (passo 6).

## 6. WhatsApp (opcional)

Configure o webhook da Meta direto na VPS: `https://api.suaempresa.com.br/webhooks/whatsapp`.
As variáveis `WHATSAPP_VERIFY_TOKEN` e `WHATSAPP_APP_SECRET` vão no `.env` da VPS. Os outros passos estão no README.

## 7. Rotina de manutenção

Na VPS, dentro de `/opt/rotafacil` (o atalho `dc` evita repetir o nome do arquivo):

```bash
alias dc='docker compose -f docker-compose.vps.yml'
```

| Quando | O quê | Comando |
|---|---|---|
| A cada atualização da API | Baixar e aplicar | `git pull && dc up -d --build` |
| Diário (automático) | Cópia do banco do Supabase em `./backups` (14 dias) | já roda sozinho |
| **Semanal** | **Copiar um backup para fora da VPS** | no seu computador: `scp root@IP:/opt/rotafacil/backups/<arquivo>.dump .` |
| Mensal | Atualizar o mapa | `./scripts/prepare-osrm.sh centro-oeste && dc restart osrm` |
| Quando algo estranhar | Ver os logs | `dc logs --tail=100 app` |

O plano Pro do Supabase também faz backup diário por conta própria. A cópia na VPS é uma segunda garantia,
e é a única no plano gratuito.

### Restaurar um backup no Supabase

```bash
dc stop app
docker run --rm -v "$PWD/backups:/backups" -v "$PWD/certs:/certs" \
  -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/certs/supabase-ca.crt postgres:17-alpine \
  pg_restore -d "$(grep ^DATABASE_URL= .env | cut -d= -f2- | tr -d "'")" --clean --if-exists --no-owner /backups/ARQUIVO.dump
dc start app
```

## 8. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Painel abre, mas o login dá erro | `API_ORIGIN` errado na Vercel, ou a API fora do ar | Abra `https://api.suaempresa.com.br/api/health`; confira a variável e faça *Redeploy* na Vercel |
| Build da Vercel falha com "Defina API_ORIGIN" | Variável não criada | Passo 5.3 |
| `app` reinicia sem parar; log com `self-signed certificate` ou `unable to verify` | Certificado do Supabase ausente ou errado | Confira `certs/supabase-ca.crt` (passo 2.3) |
| Log com `ENETUNREACH` ou endereço IPv6 | URL da *Direct connection* | Use a URL do **Session pooler** (passo 2.2) |
| Log com `password authentication failed` | Senha errada ou com caractere especial sem codificar | Passo 2.2 |
| Navegador avisa "conexão não segura" em `api.` | DNS ainda não aponta para a VPS, ou a porta 80 está bloqueada | `dc logs caddy` |
| Mapa cinza | Chave da MapTiler errada ou restrita a outro domínio | Na MapTiler, libere a origem `https://rotas.suaempresa.com.br` |
| "distâncias estimadas" ao gerar rotas | OSRM parado ou mapa não preparado | `dc logs osrm`; rode `./scripts/prepare-osrm.sh centro-oeste` |

## Limitações conhecidas

- **Limite de tentativas por IP (link do cliente):** a API calcula o IP do cliente pelo cabeçalho
  `X-Forwarded-For`, considerando dois intermediários (Vercel e Caddy, `TRUST_PROXY=2`). Quem acessar
  `api.suaempresa.com.br` direto, sem passar pela Vercel, pode forjar esse cabeçalho e escapar do limite.
  Os tokens continuam impossíveis de adivinhar; o limite é só uma proteção a mais.
