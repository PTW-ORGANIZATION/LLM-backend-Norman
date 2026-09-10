#!/usr/bin/env bash
# Sobe os dois lados locais e roda a suíte de contrato.
#
# O repositório do Norman precisa estar em ../Norman ou em NORMAN_REPO_PATH.
set -euo pipefail

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
norman="${NORMAN_REPO_PATH:-$(cd "$raiz/.." && pwd)/Norman}"

if [ ! -d "$norman/server/modules/ai" ]; then
  echo "Não encontrei o repositório do Norman em: $norman" >&2
  echo "Aponte NORMAN_REPO_PATH para ele." >&2
  exit 1
fi

cd "$raiz"
NORMAN_REPO_PATH="$norman" npx vitest run --config contract/vitest.config.ts "$@"
