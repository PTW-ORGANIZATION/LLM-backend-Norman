#!/bin/bash
#
# Reinstala a VPS do LLM-backend a partir do backup, numa máquina Debian 13 limpa.
#
# O backup é a pasta "conteudo" gerada pelo workflow "Backup da VPS": banco,
# .env, lista de modelos do Ollama, chaves autorizadas e configuração. Copie-a
# para a máquina nova antes de rodar.
#
# Uso, como root:
#   DOMINIO=<domínio que o Norman usa em LLM_BACKEND_URL> bash reinstalar-vps.sh /root/conteudo
#
# Variáveis opcionais:
#   USUARIO=victor_lima        dono do serviço, o mesmo que o deploy usa por SSH
#   EMAIL_CERT=<e-mail>        para o certificado do Let's Encrypt
#   NGINX_ORIGINAL=<arquivo>   a configuração original do site, se alguém com
#                              root a copiou antes da formatação; sem ela o
#                              script escreve uma equivalente
#   PULAR_MODELOS=1            não baixa os modelos do Ollama (~15 GB)
#
# Se a pasta tiver root/etc-root.tgz (cópia de /etc feita por quem tinha root),
# o certificado e o site nginx originais são restaurados dela.
#
# Depois dele, rode o deploy normal do LLM-backend (push ou re-run na main): é
# o deploy que reescreve o .env a partir dos secrets do GitHub.
set -euo pipefail

BACKUP=${1:?"informe a pasta conteudo do backup"}
DOMINIO=${DOMINIO:?"informe DOMINIO, o domínio de LLM_BACKEND_URL do Norman"}
USUARIO=${USUARIO:-victor_lima}
REPOSITORIO=https://github.com/PTW-ORGANIZATION/LLM-backend-Norman.git
ENV_DO_BACKUP="$BACKUP/config/llm-backend.env"

passo() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
falha() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || falha "rode como root"
[ -f "$ENV_DO_BACKUP" ] || falha "não achei $ENV_DO_BACKUP; a pasta informada é a 'conteudo' do backup?"

valor() { grep -E "^$1=" "$ENV_DO_BACKUP" | head -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'; }
DB_USERNAME=$(valor DB_USERNAME)
DB_PASSWORD=$(valor DB_PASSWORD)
DB_DATABASE=$(valor DB_DATABASE)
PORTA=$(valor PORT); PORTA=${PORTA:-3000}
[ -n "$DB_USERNAME" ] && [ -n "$DB_PASSWORD" ] && [ -n "$DB_DATABASE" ] \
  || falha "DB_USERNAME, DB_PASSWORD e DB_DATABASE precisam estar no .env do backup"

passo "1. Pacotes do sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates git build-essential sudo \
  postgresql-17 postgresql-17-pgvector redis-server nginx certbot python3-certbot-nginx

passo "2. Node 22 e pm2"
if ! node --version 2>/dev/null | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pm2@7
node --version

passo "3. Usuário do serviço e acesso do deploy"
id "$USUARIO" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$USUARIO"
CASA=$(getent passwd "$USUARIO" | cut -d: -f6)
install -d -m 700 -o "$USUARIO" -g "$USUARIO" "$CASA/.ssh"
if [ -f "$BACKUP/ssh/authorized_keys" ]; then
  install -m 600 -o "$USUARIO" -g "$USUARIO" "$BACKUP/ssh/authorized_keys" "$CASA/.ssh/authorized_keys"
  echo "chaves autorizadas restauradas: $(grep -c . "$BACKUP/ssh/authorized_keys")"
fi

passo "4. Postgres 17 com pgvector"
systemctl enable --now postgresql
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USERNAME') THEN
    CREATE ROLE "$DB_USERNAME" LOGIN;
  END IF;
END
\$\$;
ALTER ROLE "$DB_USERNAME" WITH LOGIN PASSWORD '$DB_PASSWORD';
SQL
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_DATABASE'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USERNAME" "$DB_DATABASE"
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB_DATABASE" <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SQL

DUMP="$BACKUP/banco/$DB_DATABASE.dump"
[ -f "$DUMP" ] || falha "não achei o dump $DUMP"
ITENS=$(mktemp)
# As extensões já foram criadas pelo superusuário; restaurá-las como o dono do
# banco falharia por permissão.
sudo -u postgres pg_restore -l "$DUMP" | grep -v ' EXTENSION ' > "$ITENS"
cp "$DUMP" /tmp/restauracao.dump && chmod 644 /tmp/restauracao.dump "$ITENS"
sudo -u postgres pg_restore --no-owner --role="$DB_USERNAME" --exit-on-error \
  -L "$ITENS" -d "$DB_DATABASE" /tmp/restauracao.dump
rm -f /tmp/restauracao.dump "$ITENS"
sudo -u postgres psql -tA -d "$DB_DATABASE" -c \
  "SELECT 'documentos=' || count(*) FROM documents UNION ALL SELECT 'trechos=' || count(*) FROM document_chunks"

passo "5. Redis"
systemctl enable redis-server
if [ -f "$BACKUP/redis/dump.rdb" ]; then
  systemctl stop redis-server
  install -m 660 -o redis -g redis "$BACKUP/redis/dump.rdb" /var/lib/redis/dump.rdb
fi
systemctl start redis-server
redis-cli ping

passo "6. Ollama"
command -v ollama >/dev/null 2>&1 || curl -fsSL https://ollama.com/install.sh | sh
if [ -d "$BACKUP/sistema/ollama.service.d" ]; then
  install -d /etc/systemd/system/ollama.service.d
  cp "$BACKUP"/sistema/ollama.service.d/*.conf /etc/systemd/system/ollama.service.d/
fi
systemctl daemon-reload
systemctl enable --now ollama
for _ in $(seq 1 30); do curl -s localhost:11434/api/tags >/dev/null && break; sleep 2; done
if [ "${PULAR_MODELOS:-0}" != 1 ]; then
  MODELOS=$(python3 -c "import json,sys; print(' '.join(m['name'] for m in json.load(open(sys.argv[1]))['models']))" \
    "$BACKUP/sistema/ollama-modelos.json")
  for modelo in $MODELOS; do
    echo "baixando $modelo"
    ollama pull "$modelo"
  done
fi
ollama list

passo "7. LLM-backend"
# O backup é do root; o dono do serviço recebe só a cópia do .env.
install -m 600 -o "$USUARIO" -g "$USUARIO" "$ENV_DO_BACKUP" "$CASA/.env.restaurado"
sudo -iu "$USUARIO" bash -s <<EOF
set -euo pipefail
if [ ! -d ~/llm-backend/.git ]; then
  git clone "$REPOSITORIO" ~/llm-backend
fi
cd ~/llm-backend
git checkout main
git pull --ff-only origin main
mv ~/.env.restaurado .env
npm ci
npm run build
npm run migration:run
pm2 delete llm-backend >/dev/null 2>&1 || true
pm2 start ecosystem.config.js --only llm-backend --update-env
pm2 save
EOF
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$USUARIO" --hp "$CASA" >/dev/null
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORTA/health" >/dev/null && break; sleep 2; done
curl -s "http://127.0.0.1:$PORTA/health"; echo

passo "8. nginx com TLS na porta 8443"
SITE=/etc/nginx/sites-available/llm-backend-internal.conf
# Se alguém com root copiou /etc antes da formatação (root/etc-root.tgz), o
# certificado e o site originais voltam de lá, e o certbot não é chamado.
if [ -f "$BACKUP/root/etc-root.tgz" ]; then
  tar xzf "$BACKUP/root/etc-root.tgz" -C / etc/letsencrypt 2>/dev/null \
    && echo "certificado restaurado da cópia do root"
  if [ -z "${NGINX_ORIGINAL:-}" ]; then
    NGINX_ORIGINAL=$(mktemp)
    tar xzf "$BACKUP/root/etc-root.tgz" -O etc/nginx/sites-available/llm-backend-internal.conf > "$NGINX_ORIGINAL" 2>/dev/null \
      && [ -s "$NGINX_ORIGINAL" ] && echo "site nginx original restaurado da cópia do root" || NGINX_ORIGINAL=
  fi
fi
if [ ! -f "/etc/letsencrypt/live/$DOMINIO/fullchain.pem" ]; then
  if [ -n "${EMAIL_CERT:-}" ]; then
    certbot certonly --nginx --non-interactive --agree-tos -m "$EMAIL_CERT" -d "$DOMINIO"
  else
    certbot certonly --nginx --non-interactive --agree-tos --register-unsafely-without-email -d "$DOMINIO"
  fi
fi
if [ -n "${NGINX_ORIGINAL:-}" ] && [ -f "$NGINX_ORIGINAL" ]; then
  cp "$NGINX_ORIGINAL" "$SITE"
else
  cat > "$SITE" <<EOF
# Porta de entrada do Norman para o LLM-backend: TLS aqui, o serviço em 127.0.0.1:$PORTA.
server {
    listen 8443 ssl;
    listen [::]:8443 ssl;
    server_name $DOMINIO;

    ssl_certificate     /etc/letsencrypt/live/$DOMINIO/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMINIO/privkey.pem;

    # A revisão de arte manda a imagem no corpo; o serviço aceita até 16 MB.
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:$PORTA;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # As gerações em fluxo chegam aos poucos, e a ingestão pode levar minutos.
        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
EOF
fi
ln -sf "$SITE" /etc/nginx/sites-enabled/llm-backend-internal.conf
nginx -t
systemctl reload nginx
curl -s "https://$DOMINIO:8443/health"; echo

passo "Pronto"
cat <<EOF
Falta:
  1. Rodar o deploy do LLM-backend (re-run do último "Deploy" da main no GitHub),
     que reescreve o .env a partir dos secrets.
  2. Se a porta do SSH não era 22, ajustar /etc/ssh/sshd_config para a porta
     do secret SSH_PORT antes do deploy.
  3. Conferir o firewall: o Norman precisa alcançar a porta 8443.
  4. No Norman, religar a base de conhecimento em Conhecimento de IA e, se a
     tela pedir, clicar em "Confirmar para todos".
EOF
