#!/bin/bash
# One-line install (macOS). Paste into Terminal:
#   curl -fsSL https://raw.githubusercontent.com/chenyiheng162-byte/n8n-job-hunter/main/get.sh | bash
# Downloads the project into ~/n8n-job-hunter (replacing an older copy there) and runs its install.sh, which installs
# everything and then opens the console in the browser. Running the same line again later updates to the newest version;
# your profile, settings and history live in ~/.n8n-job-hunter and are kept.
# Everything happens inside main(): a download of this script that is cut off halfway runs nothing.
main() {
  set -euo pipefail
  local url="${JOBHUNT_GET_URL:-https://codeload.github.com/chenyiheng162-byte/n8n-job-hunter/tar.gz/refs/heads/main}"
  local dest="$HOME/n8n-job-hunter" tmp
  [ "$(uname -s)" = Darwin ] || { echo "只支持 macOS。" >&2; exit 1; }
  if [ -e "$dest" ] && [ ! -f "$dest/install.sh" ]; then
    echo "${dest} 已经存在，但不是这个项目的文件夹。请先把它改名或移走，再运行一次。" >&2; exit 1
  fi
  if [ -d "$dest/.git" ]; then
    echo "${dest} 是一个 git 仓库（开发用的副本），不会覆盖它：请在里面直接运行 ./install.sh，或先把它改名。" >&2; exit 1
  fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/jobhunt-get.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT
  echo "正在下载求职助手……"
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 300 -o "$tmp/src.tar.gz" "$url" || {
    echo "下载失败：检查网络后再运行一次。打不开 GitHub 的话，请向发给你这行命令的人要安装包（zip）。" >&2; exit 1; }
  mkdir "$tmp/src" && tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components=1
  [ -f "$tmp/src/install.sh" ] || { echo "下载到的内容不对（里面没有 install.sh），已停止，什么都没有改动。" >&2; exit 1; }
  # swap in the new copy only once it is complete
  rm -rf "$dest.old"; if [ -e "$dest" ]; then mv "$dest" "$dest.old"; fi
  mv "$tmp/src" "$dest"; rm -rf "$dest.old"
  echo "已下载到 ${dest}"
  rm -rf "$tmp"; trap - EXIT   # (an EXIT trap does not run across exec)
  # install.sh may need the keyboard (Xcode tools prompt, ...), not this script arriving through the pipe
  if (: </dev/tty) 2>/dev/null; then exec bash "$dest/install.sh" "$@" </dev/tty; else exec bash "$dest/install.sh" "$@"; fi
}
main "$@"
