#!/bin/bash
# Empacota na VPS tudo o que a reinstalação precisa, e manda o tar.gz pela saída.
#
# Roda na VPS, chamado pelo workflow de backup. A saída padrão é só o pacote;
# o que vai para o log (saída de erro) são nomes do que entrou ou faltou,
# nunca conteúdo: o repositório é público.
set -uo pipefail
umask 077

DESTINO=$(mktemp -d)
trap 'rm -rf "$DESTINO"' EXIT
cd "$DESTINO"
mkdir -p banco config pm2 redis ssh sistema

registrar() { echo "$*" >> MANIFESTO.txt; echo "$*" >&2; }

export PGPASSWORD="$DB_PASSWORD"
CONEXAO="-h $DB_HOST -p $DB_PORT -U $DB_USERNAME"

for banco in "$DB_DATABASE" llm_prod_db; do
  if pg_dump $CONEXAO -d "$banco" -Fc --no-owner -f "banco/$banco.dump" 2>/dev/null; then
    registrar "ok     banco $banco ($(du -h "banco/$banco.dump" | cut -f1))"
  else
    rm -f "banco/$banco.dump"
    registrar "falhou banco $banco (sem permissao ou inexistente)"
  fi
done
psql $CONEXAO -d "$DB_DATABASE" -At -c "select extname || ' ' || extversion from pg_extension" > banco/extensoes.txt 2>/dev/null \
  && registrar "ok     lista de extensoes"

copiar() {
  local origem="$1" destino="$2"
  if [ -e "$origem" ] && cp -RL "$origem" "$destino" 2>/dev/null; then
    registrar "ok     $origem"
  else
    registrar "falhou $origem"
  fi
}

copiar "$HOME/llm-backend/.env" config/llm-backend.env
copiar "$HOME/llm-backend/ecosystem.config.js" config/llm-backend.ecosystem.config.js
copiar "$HOME/llm-backend-envs" config/llm-backend-envs
copiar "$HOME/llm-backend-prod/.env" config/llm-backend-prod.env
copiar "$HOME/.pm2/dump.pm2" pm2/dump.pm2
copiar "$HOME/.ssh/authorized_keys" ssh/authorized_keys
copiar /etc/nginx/sites-enabled/llm-backend-internal.conf sistema/nginx-llm-backend-internal.conf
copiar /etc/nginx/sites-enabled/default sistema/nginx-default
copiar /etc/redis/redis.conf sistema/redis.conf
copiar /etc/postgresql/17/main/postgresql.conf sistema/postgresql.conf
copiar /etc/postgresql/17/main/pg_hba.conf sistema/pg_hba.conf
copiar /etc/systemd/system/ollama.service sistema/ollama.service
copiar /etc/systemd/system/ollama.service.d sistema/ollama.service.d

# Legiveis por qualquer usuario, e uteis para reconstruir igual.
copiar /etc/ssh/sshd_config sistema/sshd_config
copiar /etc/ssh/sshd_config.d sistema/sshd_config.d
copiar /etc/nginx/nginx.conf sistema/nginx.conf
copiar /etc/hosts sistema/hosts
copiar /etc/fstab sistema/fstab
copiar /etc/apt/sources.list.d sistema/apt-sources.list.d
dpkg-query -W -f '${Package}\n' > sistema/pacotes-instalados.txt 2>/dev/null && registrar "ok     lista de pacotes"
getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 {print $1}' > sistema/usuarios.txt && registrar "ok     lista de usuarios"

# O que so o root le. Funciona se o usuario do deploy tiver sudo sem senha;
# se nao tiver, registra a falha e segue.
mkdir -p root
if sudo -n true 2>/dev/null; then
  sudo -n tar czf - /etc/nginx /etc/letsencrypt /etc/redis /etc/postgresql /etc/ssh \
    /etc/ufw /etc/iptables /var/spool/cron 2>/dev/null > root/etc-root.tgz
  registrar "ok     arquivos do root ($(du -h root/etc-root.tgz | cut -f1))"
  sudo -n crontab -l > root/crontab-root.txt 2>/dev/null
  { sudo -n ufw status verbose; sudo -n iptables-save; sudo -n nft list ruleset; } > root/firewall.txt 2>/dev/null
  registrar "ok     firewall e crontab do root"
else
  registrar "falhou arquivos do root (sudo pede senha)"
fi

(cd "$HOME/llm-backend" && git rev-parse HEAD) > sistema/commit-do-llm-backend.txt 2>/dev/null \
  && registrar "ok     commit publicado do llm-backend"
curl -s -m 10 "$OLLAMA_HOST/api/tags" > sistema/ollama-modelos.json 2>/dev/null && registrar "ok     lista de modelos do ollama"

if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" --rdb redis/dump.rdb >/dev/null 2>&1; then
  registrar "ok     redis ($(du -h redis/dump.rdb | cut -f1))"
else
  registrar "falhou redis"
fi

{
  echo "coletado em: $(date -Is)"
  (lsb_release -ds 2>/dev/null || grep PRETTY_NAME /etc/os-release)
  echo "node $(node --version) · npm $(npm --version) · pm2 $(pm2 --version 2>/dev/null)"
  psql --version; redis-server --version; ollama --version 2>&1
} > sistema/versoes.txt 2>/dev/null

tar czf - .
