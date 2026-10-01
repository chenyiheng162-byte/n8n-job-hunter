#!/usr/bin/env bash
# Publishes the release folder (what make-package.sh built and scanned) to GitHub: creates the repository the first time,
# afterwards replaces its contents with a new commit. The commit uses GitHub's private "noreply" address, so no personal
# e-mail is published.   Usage: scripts/publish.sh [owner/repo]        (default: <your login>/n8n-job-hunter)
# Making code public is an outward-facing act: run it only when the owner has said so.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
command -v gh >/dev/null || { echo "需要 gh（GitHub 命令行）" >&2; exit 1; }
LOGIN="$(gh api user --jq .login)"; UID_="$(gh api user --jq .id)"
REPO="${1:-$LOGIN/n8n-job-hunter}"
bash "$SRC/scripts/make-package.sh" --no-zip
STAGE="$SRC/dist/stage/n8n-job-hunter"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/jobhunt-publish.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
AUTHOR_NAME="$LOGIN"; AUTHOR_EMAIL="${UID_}+${LOGIN}@users.noreply.github.com"
if gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo clone "$REPO" "$WORK/repo" -- -q
else
  mkdir "$WORK/repo"; git -C "$WORK/repo" init -q -b main
fi
rsync -a --delete --exclude '.git' "$STAGE/" "$WORK/repo/"
cd "$WORK/repo"
git config user.name "$AUTHOR_NAME"; git config user.email "$AUTHOR_EMAIL"
git add -A
if git diff --cached --quiet; then echo "和 GitHub 上的内容一样，没有新的提交"; else
  git commit -q -m "${PUBLISH_MESSAGE:-release: $(date +%F)}"
fi
if gh repo view "$REPO" >/dev/null 2>&1; then git push -q origin HEAD:main; else
  gh repo create "$REPO" --public --source=. --remote=origin --push --description "Daily job search and application agent for macOS: finds postings, scores them with AI, applies by e-mail when an address exists, lists the rest for you to apply (n8n)" >/dev/null
fi
echo "已发布：https://github.com/$REPO"
echo "一行安装命令："
echo "  curl -fsSL https://raw.githubusercontent.com/$REPO/main/get.sh | bash"
