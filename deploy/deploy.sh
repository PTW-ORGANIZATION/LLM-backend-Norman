#!/usr/bin/env bash
#
# Publica o llm-backend na VPS. Substitui a sequência manual de git pull, npm ci,
# migration e restart que já causou duas quebras: uma por migração esquecida e
# outra por `.env` restaurado de backup, que devolveu NORMAN_INTERNAL_URL para o
# ambiente errado e faria toda ingestão falhar em silêncio.
#
# O script NUNCA escreve no .env. Ele confere que o arquivo está coerente e
# aborta ANTES de reiniciar se não estiver — servidor no ar com configuração
# errada é pior que deploy que não acontece.
#
# Uso, na VPS, como o usuário dono do serviço:
#   ./deploy/deploy.sh              # confere e publica
#   ./deploy/deploy.sh --check      # só confere, não publica
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM2_APP="${PM2_APP:-llm-backend}"
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

cd "$APP_DIR"

log()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

log "1. Configuração"

[ -f .env ] || fail ".env não existe em $APP_DIR"

# Sem estes o serviço sobe e falha só na primeira ingestão, o que é difícil de
# ligar à causa. Melhor recusar aqui.
for chave in DB_HOST DB_DATABASE REDIS_HOST OLLAMA_HOST INTERNAL_API_TOKEN NORMAN_INTERNAL_URL; do
  grep -qE "^${chave}=.+" .env || fail "$chave ausente ou vazia no .env"
done
ok "todas as chaves obrigatórias presentes"

ALVO=$(grep -oP '(?<=^NORMAN_INTERNAL_URL=).*' .env | tr -d '[:space:]')
case "$ALVO" in
  https://*) ok "NORMAN_INTERNAL_URL = $ALVO" ;;
  *) fail "NORMAN_INTERNAL_URL precisa ser https://... (está: '$ALVO')" ;;
esac

# O erro de 03/09: o .env voltou a apontar para produção enquanto o ambiente
# servido era develop. O cabeçalho do .env declara o ambiente; se as duas coisas
# discordarem, o deploy para.
DECLARADO=$(grep -oP '(?<=^# AMBIENTE SERVIDO: )\S+' .env || true)
if [ -n "$DECLARADO" ]; then
  case "$DECLARADO:$ALVO" in
    develop:https://dev.normanapp.com|homologation:https://hml.normanapp.com|production:https://normanapp.com)
      ok "ambiente declarado ($DECLARADO) bate com o alvo" ;;
    *) fail "o .env declara '$DECLARADO' mas aponta para '$ALVO' — um dos dois está errado" ;;
  esac
else
  echo "  ! o .env não declara '# AMBIENTE SERVIDO:'; sem isso não dá para conferir a coerência"
fi

if [ "$CHECK_ONLY" = true ]; then
  log "Só conferência. Nada publicado."
  exit 0
fi

log "2. Código"
git fetch origin --quiet
git reset --hard "origin/$(git rev-parse --abbrev-ref HEAD)" --quiet
ok "em $(git rev-parse --short HEAD)"

log "3. Dependências e migrações"
npm ci --silent
npm run migration:run 2>&1 | grep -iE "has been executed|No migrations" | sed 's/^/  /' || true
ok "migrações aplicadas"

log "4. Build"
npm run build >/dev/null
[ -f dist/main.js ] || fail "build não gerou dist/main.js, que é o que o PM2 executa"
ok "dist/main.js gerado"

log "5. Restart"
pm2 restart "$PM2_APP" --update-env >/dev/null
sleep 6

PORTA=$(grep -oP '(?<=^PORT=)\d+' .env || echo 3000)
curl -fsS --max-time 15 "http://127.0.0.1:${PORTA}/health" | sed 's/^/  /' || fail "/health não respondeu após o restart"
echo
ok "no ar"
