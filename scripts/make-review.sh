#!/usr/bin/env bash
# Builds the review package for outside reviewers: the clean source snapshot (exactly what is published), the real test
# output, the secret/personal-data scan result and the git history, plus the hand-written START-HERE.md, REVIEW.md and
# REVIEW-HISTORY.md that already sit in the output folder (they are kept, never overwritten).
# Usage: scripts/make-review.sh [OUTDIR]     default: ../../notes/n8n-job-hunter-review   (also writes OUTDIR.zip)
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$SRC/../../notes/n8n-job-hunter-review}"; mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
export PATH="$HOME/.n8n-job-hunter/.runtime/node/bin:$PATH"; command -v node >/dev/null || export PATH="$HOME/.n8n-morning-brief/.runtime/node/bin:$PATH"
bash "$SRC/scripts/make-package.sh" --no-zip >/dev/null
STAGE="$SRC/dist/stage/n8n-job-hunter"
rsync -a --delete --exclude START-HERE.md --exclude REVIEW.md --exclude REVIEW-HISTORY.md --exclude COMMITS.txt --exclude TEST-RESULTS.txt --exclude SCAN-RESULT.txt --exclude FILES.txt "$STAGE/" "$OUT/"
for f in START-HERE.md REVIEW.md REVIEW-HISTORY.md; do [ -f "$OUT/$f" ] || echo "WARNING: $f is missing in $OUT (write it first)" >&2; done
# evidence, produced now rather than described
( cd "$SRC" && node --test "test/*.test.mjs" 2>&1 ) > "$OUT/TEST-RESULTS.txt" || true
{ echo "# node $(node -v) · $(date '+%F %T %z')"; echo "# git history of the published repository"; gh api repos/chenyiheng162-byte/n8n-job-hunter/commits --jq '.[] | "\(.sha[0:7]) \(.commit.author.date) \(.commit.message)"' 2>&1; } > "$OUT/COMMITS.txt"
( cd "$OUT" && find . -type f ! -name 'FILES.txt' ! -name '.DS_Store' | sort | while read -r f; do printf '%7s lines  %s\n' "$(wc -l < "$f" | tr -d ' ')" "$f"; done ) > "$OUT/FILES.txt"
node "$SRC/scripts/scan-release.mjs" "$OUT" --self-test 2>&1 | tee "$OUT/SCAN-RESULT.txt"
rm -f "$OUT.zip"; ( cd "$(dirname "$OUT")" && zip -qr "$OUT.zip" "$(basename "$OUT")" -x '*.DS_Store' )
echo "review folder: $OUT"; echo "zip: $OUT.zip ($(du -h "$OUT.zip" | cut -f1))"
