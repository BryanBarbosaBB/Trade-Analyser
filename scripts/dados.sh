#!/usr/bin/env bash
# Ramo `dados` (um único commit, substituído a cada gravação). Uso: dados.sh baixa|salva <pasta>
# Precisa de GH_TOKEN e GITHUB_REPOSITORY (no Actions).
set -euo pipefail
acao="$1"; dir="$2"
url="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

case "$acao" in
  baixa)
    for i in 1 2 3; do
      rm -rf "$dir.novo"
      if git clone -q --depth 1 --branch dados "$url" "$dir.novo"; then
        rm -rf "$dir"; mv "$dir.novo" "$dir"; exit 0
      fi
      # ramo ainda não existe (primeira vez): começa vazio. Falha de rede: tenta de novo, para não apagar o histórico.
      code=0; git ls-remote --exit-code --heads "$url" dados > /dev/null || code=$?
      if [ "$code" = "2" ]; then mkdir -p "$dir"; exit 0; fi
      sleep 10
    done
    echo "ERRO: não consegui baixar o ramo dados" >&2; exit 1 ;;
  salva)
    cd "$dir"
    rm -rf .git
    git init -q -b dados
    git config user.name "varredura"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git add -A
    git commit -q -m "Varredura $(date -u +'%Y-%m-%d %H:%M') UTC"
    git push -q --force "$url" dados ;;
  *) echo "uso: dados.sh baixa|salva <pasta>" >&2; exit 2 ;;
esac
