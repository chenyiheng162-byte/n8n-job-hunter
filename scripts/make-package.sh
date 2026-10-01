#!/usr/bin/env bash
# Builds the clean release folder dist/stage/n8n-job-hunter (exactly what is published to GitHub), scans it for secrets and
# personal data, and zips it as the fallback install package.   Usage: scripts/make-package.sh [--no-zip]
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.n8n-job-hunter/.runtime/node/bin:$PATH"; command -v node >/dev/null || export PATH="$HOME/.n8n-morning-brief/.runtime/node/bin:$PATH"
STAGE="$SRC/dist/stage/n8n-job-hunter"
rm -rf "$SRC/dist/stage"; mkdir -p "$STAGE"
node "$SRC/scripts/build-workflow.mjs" >/dev/null
# an explicit list: new files are NOT published by accident (upstream/ holds another author's leaked keys and is never included)
ITEMS=(README.md 安装说明.md LICENSE NOTICE.md package.json package-lock.json config.example.env profile.example.md install.sh uninstall.sh get.sh "双击安装.command" .gitignore .github docs scripts workflows test)
if git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # only files git knows about: a scratch file or a captured feed left in scripts/ or test/ never ships
  git -C "$SRC" ls-files -z -- "${ITEMS[@]}" | rsync -a --files-from=- --from0 "$SRC/" "$STAGE/"
  cp "$SRC/workflows/job-hunter.json" "$SRC/workflows/BUILD" "$STAGE/workflows/"   # just rebuilt above
else
  for item in "${ITEMS[@]}"; do [ -e "$SRC/$item" ] && rsync -a --exclude '.DS_Store' --exclude 'node_modules' --exclude '*.local' "$SRC/$item" "$STAGE/"; done
fi
node "$SRC/scripts/scan-release.mjs" "$STAGE" --self-test
echo "release folder: $STAGE"
if [ "${1:-}" != "--no-zip" ]; then
  rev="$(date +%Y%m%d)"; out="$SRC/dist/n8n-job-hunter-$rev.zip"
  (cd "$SRC/dist/stage" && rm -f "$out" && zip -qr "$out" n8n-job-hunter -x '*.DS_Store')
  echo "zip: $out ($(du -h "$out" | cut -f1))"
fi
