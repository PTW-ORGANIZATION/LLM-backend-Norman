#!/bin/bash
# Inventário da VPS do LLM-backend, para reinstalar depois da formatação.
#
# Roda na VPS. Imprime só versões, tamanhos e nomes: o log do workflow que o
# chama é público, e nenhum valor de variável, conteúdo de tabela, endereço ou
# segredo pode sair daqui.
set -uo pipefail

secao() { printf '\n== %s\n' "$*"; }

secao "sistema"
(lsb_release -ds 2>/dev/null || grep PRETTY_NAME /etc/os-release) | head -1
uname -r
echo "cpus=$(nproc) memoria=$(free -g | awk '/Mem:/{print $2}')G"
df -h "$HOME" | tail -1 | awk '{print "disco total="$2" usado="$3" livre="$4}'

secao "ferramentas"
for t in node npm pm2 git psql pg_dump redis-server redis-cli ollama nginx docker python3; do
  if command -v "$t" >/dev/null 2>&1; then
    printf '%-13s %s\n' "$t" "$("$t" --version 2>&1 | head -1)"
  else
    printf '%-13s ausente\n' "$t"
  fi
done

secao "servicos em execucao"
systemctl list-units --type=service --state=running --no-legend 2>/dev/null \
  | awk '{print $1}' | grep -Ei 'postgres|redis|ollama|nginx|pm2|docker|caddy|cron' || echo "nenhum relevante"

secao "pm2"
pm2 jlist 2>/dev/null | node -e '
  let b=""; process.stdin.on("data",d=>b+=d).on("end",()=>{
    try { for (const a of JSON.parse(b)) console.log(a.name, a.pm2_env.status, a.pm2_env.exec_mode, a.pm2_env.pm_exec_path.replace(process.env.HOME,"~")); }
    catch { console.log("pm2 sem processos ou ilegivel"); }
  })'

secao "pastas no home"
for d in "$HOME"/*/; do du -sh "$d" 2>/dev/null | sed "s#$HOME#~#"; done

secao "variaveis do .env (so os nomes)"
if [ -f "$HOME/llm-backend/.env" ]; then
  grep -oE '^[A-Z0-9_]+=' "$HOME/llm-backend/.env" | tr -d '=' | tr '\n' ' '; echo
fi

secao "postgres"
export PGPASSWORD="$DB_PASSWORD"
PSQL="psql -h $DB_HOST -p $DB_PORT -U $DB_USERNAME -d $DB_DATABASE -At"
$PSQL -c "select split_part(version(), ' on ', 1)" 2>&1 | head -1
echo "extensoes: $($PSQL -c "select string_agg(extname || ' ' || extversion, ', ') from pg_extension" 2>&1)"
echo "tamanho do banco: $($PSQL -c "select pg_size_pretty(pg_database_size(current_database()))" 2>&1)"
echo "tabelas (tamanho, linhas estimadas):"
$PSQL -F ' | ' -c "select relname, pg_size_pretty(pg_total_relation_size(c.oid)), reltuples::bigint
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relkind = 'r'
                   order by pg_total_relation_size(c.oid) desc" 2>&1 | head -40
echo "bancos no servidor: $($PSQL -c "select string_agg(datname || ' ' || pg_size_pretty(pg_database_size(datname)), ', ') from pg_database where not datistemplate" 2>&1)"

secao "redis"
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" INFO server 2>&1 | grep -E 'redis_version' || echo "redis-cli indisponivel"
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" INFO keyspace 2>&1 | grep -E '^db' || true

secao "ollama"
curl -s -m 10 "$OLLAMA_HOST/api/tags" 2>/dev/null | node -e '
  let b=""; process.stdin.on("data",d=>b+=d).on("end",()=>{
    try { for (const m of JSON.parse(b).models) console.log(m.name, (m.size/1e9).toFixed(1)+"GB"); }
    catch { console.log("ollama nao respondeu"); }
  })'
case "$OLLAMA_HOST" in
  *127.0.0.1*|*localhost*) echo "ollama roda nesta mesma maquina" ;;
  *) echo "ollama roda em OUTRA maquina" ;;
esac

secao "agendamentos"
echo "linhas no crontab do usuario: $(crontab -l 2>/dev/null | grep -vc '^#')"
ls /etc/nginx/sites-enabled 2>/dev/null | sed 's/^/nginx site: /' || true
