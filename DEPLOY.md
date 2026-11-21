# Colocando o RotaFácil no ar

Guia para a primeira instalação, região **Centro-Oeste**. Tempo total: cerca de 1 hora,
quase toda esperando o mapa ser preparado.

## 1. O que providenciar

| Item | Recomendação | Observação |
|---|---|---|
| **Domínio** | `.com.br` no [registro.br](https://registro.br) | Você pode usar um subdomínio para o sistema, ex.: `rotas.suaempresa.com.br` |
| **Servidor (VPS)** | Ubuntu **24.04**, **4 vCPU, 8 GB de RAM, 80 GB SSD**, datacenter **no Brasil** | Funciona com 4 GB de RAM (o script cria swap), mas a preparação do mapa fica lenta |
| **Mapa (tiles)** | Conta gratuita na [MapTiler](https://www.maptiler.com) | O servidor público do OpenStreetMap não permite uso comercial |
| **E-mail** | Qualquer um seu | Recebe os avisos do certificado HTTPS |

Na VPS, escolha **acesso por chave SSH** (mais seguro que senha), se o provedor oferecer.

> **MapTiler:** depois de criar a conta, copie a chave em *API Keys* e, nas configurações dela,
> restrinja as origens ao seu domínio (`https://rotas.suaempresa.com.br`). A chave fica visível
> no navegador; a restrição impede que outros sites a usem.

## 2. Apontar o domínio para o servidor

No painel de DNS do domínio (no registro.br: *Domínios → seu domínio → DNS → Editar zona*),
crie um registro:

| Tipo | Nome | Valor |
|---|---|---|
| `A` | `rotas` (ou vazio, para usar o domínio principal) | IP do servidor (aparece no painel da VPS) |

A propagação leva de alguns minutos a algumas horas. Para conferir, rode no seu computador:
`nslookup rotas.suaempresa.com.br`. A resposta deve mostrar o IP do servidor.

## 3. Copiar o projeto para o servidor

Acesse o servidor: `ssh root@IP_DO_SERVIDOR`

O repositório é privado, então o servidor precisa de uma **chave de leitura** (deploy key):

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

Copie a linha que aparecer. No GitHub, abra o repositório → *Settings → Deploy keys → Add deploy key*,
cole a linha, deixe **sem** permissão de escrita e salve. Depois:

```bash
apt-get update && apt-get install -y git
git clone git@github.com:mrcesardev/rotafacil.git /opt/rotafacil
cd /opt/rotafacil
git checkout claude/awesome-brown-getox6   # enquanto as mudanças não estiverem na branch principal
```

## 4. Instalar

```bash
sudo ./scripts/setup-server.sh
```

O script pergunta o **domínio**, o **e-mail** e a **chave da MapTiler**. Depois ele:
- instala o Docker;
- ativa o firewall (só SSH, HTTP e HTTPS ficam abertos);
- gera uma senha forte para o banco;
- baixa e prepara o mapa do Centro-Oeste;
- sobe tudo com HTTPS automático.

No fim, ele mostra o endereço de acesso.

## 5. Primeiro acesso

1. Abra `https://rotas.suaempresa.com.br` e **crie a conta da empresa**. A primeira pessoa vira a dona da conta.
2. Em ⚙️ **Configurar**, ajuste o **fuso horário**. Isso é importante no Centro-Oeste:
   - **Goiás e Distrito Federal:** Brasília;
   - **Mato Grosso:** Cuiabá;
   - **Mato Grosso do Sul:** Campo Grande.
3. Defina a base padrão, o horário de saída e os minutos por entrega.
4. Em **Equipe**, crie os acessos de quem vai operar.
5. Cadastre os entregadores e faça uma rota de teste. Abra o link do entregador no celular e teste o
   botão "Recalcular a partir de onde estou" (o GPS só funciona com HTTPS, que já estará ativo).

## 6. Rotina de manutenção

| Quando | O quê | Comando (dentro de `/opt/rotafacil`) |
|---|---|---|
| A cada atualização do sistema | Baixar e aplicar | `git pull && docker compose up -d --build` |
| Diário (automático) | Backup do banco em `./backups` (guarda 14 dias) | já roda sozinho |
| **Semanal** | **Copiar um backup para fora do servidor** | no seu computador: `scp root@IP:/opt/rotafacil/backups/<arquivo>.dump .` |
| Mensal | Atualizar o mapa (ruas novas) | `./scripts/prepare-osrm.sh centro-oeste && docker compose restart osrm` |
| Quando algo estranhar | Ver os logs | `docker compose logs --tail=100 app` |

> O backup diário fica **no mesmo servidor**. Se o servidor for perdido, ele vai junto. Por isso a
> cópia semanal para outro lugar é importante. Uma cópia automática para armazenamento externo
> pode ser configurada depois.

### Restaurar um backup

```bash
cd /opt/rotafacil
docker compose stop app
docker compose exec -T db pg_restore -U rotafacil -d rotafacil --clean --if-exists --no-owner < backups/ARQUIVO.dump
docker compose start app
```

## 7. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Navegador avisa "conexão não segura" | Domínio ainda não aponta para o servidor, ou a porta 80 está bloqueada | Confira o passo 2; `docker compose logs caddy` mostra o erro do certificado |
| Mapa cinza | Chave da MapTiler errada ou restrita a outro domínio | Confira `TILE_URL` no `.env` e as origens na MapTiler; depois `docker compose up -d` |
| "distâncias estimadas" ao gerar rotas | OSRM parado ou mapa não preparado | `docker compose logs osrm`; rode `./scripts/prepare-osrm.sh centro-oeste` |
| Botão de GPS não funciona | Página aberta sem HTTPS, ou permissão negada no celular | Use sempre o endereço `https://` |
| Preparação do mapa trava ou é "Killed" | Pouca memória | Use um servidor de 8 GB, ou confirme que o swap foi criado (`swapon --show`) |
