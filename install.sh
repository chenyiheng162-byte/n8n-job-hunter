#!/usr/bin/env bash
# One-command installer for macOS.   Usage:  ./install.sh [HH:MM] [--no-schedule] [--no-console]
#   HH:MM          the daily run time (default 08:00; it can be changed later in the console)
#   --no-schedule  do not install the daily launchd job (tests)
#   --no-console   do not open the console at the end
# It installs into JOBHUNT_HOME (default ~/.n8n-job-hunter), deliberately OUTSIDE ~/Documents: macOS does not let scheduled
# jobs read that folder. Safe to run again: it never overwrites your profile.md, settings or history.
#
# Node + n8n (the engine, about 3 GB) are found in this order:
#   1. JOBHUNT_RUNTIME, if you set it           2. this project's own copy from an earlier install
#   3. the n8n-morning-brief project's copy, if it is there (shared, nothing is downloaded)
#   4. otherwise: Node is downloaded (SHA-256 pinned) and n8n is installed from the locked package-lock.json
set -euo pipefail
umask 077   # everything this script creates is private to the current user

SRC="$(cd "$(dirname "$0")" && pwd)"
[ -x "$SRC/scripts/schedule.sh" ] || chmod u+x "$SRC"/*.sh "$SRC"/*.command "$SRC"/scripts/*.sh "$SRC"/scripts/jobhunt 2>/dev/null || true   # some ways of copying a zip lose the executable bit
HOME_DIR="${JOBHUNT_HOME:-$HOME/.n8n-job-hunter}"
NODE_VERSION="v24.21.0"   # n8n 2.x needs Node >= 24
# SHA-256 of the official tarballs, pinned here so the download is not trusted just because it matches a checksum file from the
# same server (values from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt).
NODE_SHA256_ARM64="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"
NODE_SHA256_X64="1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097"
NOSCHED=0; CONSOLE=1; TIME=""
for a in "$@"; do case "$a" in --no-schedule) NOSCHED=1 ;; --no-console) CONSOLE=0 ;; -h|--help) sed -n '2,13p' "$0"; exit 0 ;; [0-2][0-9]:[0-5][0-9]) TIME="$a" ;; *) echo "不认识的选项：$a" >&2; exit 1 ;; esac; done
# no time given: keep the one the user chose earlier (the console / schedule.sh record it), else 08:00
[ -n "$TIME" ] || [ ! -f "$HOME_DIR/config.local.env" ] || TIME="$(sed -n "s/^HUNT_TIME=[\"']\{0,1\}\([0-2][0-9]:[0-5][0-9]\)[\"']\{0,1\}$/\1/p" "$HOME_DIR/config.local.env" | tail -1)"   # (quoted or bare, as the loader accepts; no file yet on a fresh install: sed must not run, set -e would stop here)
[ -n "$TIME" ] || TIME="08:00"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
[ "$((10#${TIME%%:*}))" -le 23 ] || die "小时要在 00-23 之间"

# ---------- 1. preflight ----------
say "检查这台 Mac"
[ "$(uname -s)" = Darwin ] || die "只支持 macOS（定时任务用的是 launchd）。"
for tool in curl tar shasum rsync sqlite3 plutil mktemp; do command -v "$tool" >/dev/null || die "缺少系统工具：${tool}"; done
case "$(uname -m)" in arm64) PLATFORM=darwin-arm64; NODE_SHA256="$NODE_SHA256_ARM64" ;; x86_64) PLATFORM=darwin-x64; NODE_SHA256="$NODE_SHA256_X64" ;; *) die "不支持的处理器：$(uname -m)" ;; esac
case "$SRC" in "$HOME_DIR"|"$HOME_DIR"/*) die "请在下载解压出来的文件夹里运行 install.sh，不要在 ${HOME_DIR} 里运行。" ;; esac
# an update must not replace the scripts under a running job (and schedule.sh would refuse at the very end anyway)
if [ -f "$HOME_DIR/run.lockf" ] && [ -x /usr/bin/lockf ]; then /usr/bin/lockf -k -s -t 0 "$HOME_DIR/run.lockf" /usr/bin/true || die "求职助手正在运行中（通常几分钟），请等它结束后再运行安装命令。什么都还没有改动。"; fi
EXPECTED_N8N="$(sed -n 's/.*"n8n": *"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -1)"
has_runtime() { [ -x "$1/.runtime/node/bin/node" ] && [ -x "$1/node_modules/.bin/n8n" ] && [ -d "$1/node_modules/nodemailer" ]; }
n8n_version() { PATH="$1/.runtime/node/bin:$PATH" "$1/node_modules/.bin/n8n" --version 2>/dev/null | tail -1; }

# ---------- 2. Node + n8n ----------
RUNTIME=""
if [ -n "${JOBHUNT_RUNTIME:-}" ]; then
  has_runtime "$JOBHUNT_RUNTIME" || die "JOBHUNT_RUNTIME=${JOBHUNT_RUNTIME} 里没有可用的 Node 和 n8n"
  RUNTIME="$JOBHUNT_RUNTIME"
elif has_runtime "$HOME_DIR" && cmp -s "$SRC/package-lock.json" "$HOME_DIR/package-lock.json"; then
  RUNTIME="$HOME_DIR"
elif has_runtime "$HOME/.n8n-morning-brief" && [ "$(n8n_version "$HOME/.n8n-morning-brief")" = "$EXPECTED_N8N" ]; then
  RUNTIME="$HOME/.n8n-morning-brief"
fi
if [ -n "$RUNTIME" ]; then
  say "使用已有的 Node 和 n8n：${RUNTIME}（不用再下载）"
  case "$RUNTIME" in "$HOME_DIR") ;; *) echo "注意：求职助手共用这个文件夹里的 Node 和 n8n。卸载或升级了那个项目之后，请重新运行本安装命令。" ;; esac
else
  say "安装 Node 和 n8n（第一次需要，约 3 GB，几分钟，请保持联网）"
  VOL="$HOME_DIR"; while [ ! -d "$VOL" ]; do VOL="$(dirname "$VOL")"; done
  FREE_GB=$(df -g "$VOL" | awk 'NR==2{print $4}'); [ "${FREE_GB:-0}" -ge 5 ] || die "需要大约 5 GB 空闲磁盘空间（现在只有 ${FREE_GB:-?} GB）。"
  # n8n's database library (sqlite3) has no prebuilt binary that installs here, so npm compiles it on this Mac: that needs
  # Apple's command line developer tools. Check BEFORE downloading anything.
  if ! { d="$(xcode-select -p 2>/dev/null)" && [ -d "$d" ]; }; then
    echo "需要先安装 Apple 的「命令行开发者工具」：安装 n8n 时要在这台 Mac 上编译一个数据库组件。" >&2
    echo "马上会弹出苹果的安装窗口，点「安装」，等它装完（通常 5–15 分钟），然后重新运行同一条安装命令。什么都还没有改动。" >&2
    echo "（没有弹出的话，在终端运行：xcode-select --install）" >&2
    xcode-select --install >/dev/null 2>&1 || true
    exit 1
  fi
  mkdir -p "$HOME_DIR/logs"
  if [ "$("$HOME_DIR/.runtime/node/bin/node" -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
    echo "下载 Node ${NODE_VERSION}（只给本项目用，不影响系统里别的 Node）"
    F="node-$NODE_VERSION-$PLATFORM.tar.gz"; TMP="$HOME_DIR/.runtime/tmp"; rm -rf "$TMP"; mkdir -p "$TMP"
    curl -fsSL --retry 4 --retry-delay 3 --connect-timeout 20 --max-time 600 -o "$TMP/$F" "https://nodejs.org/dist/$NODE_VERSION/$F" || die "下载 Node 失败：检查网络后重新运行安装命令（已完成的部分会跳过）。"
    printf '%s  %s\n' "$NODE_SHA256" "$F" > "$TMP/sha.txt"
    (cd "$TMP" && shasum -a 256 -c sha.txt >/dev/null) || die "下载的 Node 校验值不对（和写死的 SHA-256 不一致），已停止。"
    tar -xzf "$TMP/$F" -C "$TMP" && rm -rf "$HOME_DIR/.runtime/node" && mv "$TMP/node-$NODE_VERSION-$PLATFORM" "$HOME_DIR/.runtime/node" && rm -rf "$TMP"
  fi
  export PATH="$HOME_DIR/.runtime/node/bin:$PATH"
  echo "Node $(node -v)；正在安装 n8n（按锁定的版本）……"
  cp "$SRC/package.json" "$SRC/package-lock.json" "$HOME_DIR/"
  # SCARF_ANALYTICS=false: one of n8n's dependencies would otherwise report install statistics.
  (cd "$HOME_DIR" && SCARF_ANALYTICS=false npm ci --no-audit --no-fund 2>&1 | grep -vE 'install-scripts|npm warn' | tail -3) || true
  has_runtime "$HOME_DIR" || die "n8n 没有装好，请看上面的输出；修好网络后重新运行安装命令即可。"
  RUNTIME="$HOME_DIR"
fi
export PATH="$RUNTIME/.runtime/node/bin:$RUNTIME/node_modules/.bin:$PATH"
echo "Node $(node -v) · n8n $(n8n --version 2>/dev/null | tail -1)"

# ---------- 3. files, workflow, schedule ----------
say "安装求职助手"
mkdir -p "$HOME_DIR"/{scripts,workflows,data/n8n,logs,profile}
printf '%s\n' "$RUNTIME" > "$HOME_DIR/runtime-path"
export N8N_USER_FOLDER="$HOME_DIR/data/n8n" N8N_DIAGNOSTICS_ENABLED=false N8N_VERSION_NOTIFICATIONS_ENABLED=false
node "$SRC/scripts/build-workflow.mjs" >/dev/null
rsync -a --delete "$SRC/scripts/" "$HOME_DIR/scripts/"
rsync -a --delete "$SRC/workflows/" "$HOME_DIR/workflows/"
cp "$SRC/config.example.env" "$SRC/profile.example.md" "$HOME_DIR/"
[ -f "$HOME_DIR/profile.md" ] || cp "$SRC/profile.example.md" "$HOME_DIR/profile.md"
[ -f "$HOME_DIR/config.local.env" ] || { : > "$HOME_DIR/config.local.env"; chmod 600 "$HOME_DIR/config.local.env"; }
# Import the workflow into the job hunter's OWN n8n folder, then verify what n8n will run.
n8n import:workflow --input="$HOME_DIR/workflows/job-hunter.json" >/dev/null 2>&1 || die "导入工作流失败"
echo "工作流已导入（build $(tr -d '[:space:]' < "$HOME_DIR/workflows/BUILD")）"

if [ "$NOSCHED" = 1 ]; then echo "（--no-schedule：没有安装定时任务）"; else
  export JOBHUNT_HOME="$HOME_DIR" JOBHUNT_RUNTIME="$RUNTIME"
  bash "$HOME_DIR/scripts/schedule.sh" "$TIME" || die "安装定时任务失败"
fi

# ---------- 4. what is left for the user ----------
WAKE_TOTAL=$(( (10#${TIME%%:*} * 60 + 10#${TIME##*:} - 5 + 1440) % 1440 ))
WAKE="$(printf '%02d:%02d:00' $((WAKE_TOTAL / 60)) $((WAKE_TOTAL % 60)))"
if [ "$CONSOLE" = 1 ] && [ "$NOSCHED" != 1 ]; then
  say "装好了。接下来在浏览器里填资料和各项设置"
  cat <<MSG
马上会在浏览器里打开「求职助手控制台」：按总览页的清单填个人资料、AI、职位来源（大约 5 分钟）。
- 浏览器没有自动打开的话，把下面出现的那条 http://127.0.0.1 开头的链接复制到浏览器里。
- 填完可以关掉这个终端窗口，每天 ${TIME} 的自动运行不受影响。以后想再打开控制台：双击 ${SRC}/打开控制台.command，或在终端运行：
    ${HOME_DIR}/scripts/jobhunt console
- 建议：让 Mac 在运行前 5 分钟自动唤醒（需要管理员密码，请你自己运行；先用 pmset -g sched 看看有没有别的定时设置）：
    sudo pmset repeat wakeorpoweron MTWRFSU ${WAKE}
  晚上请插着电源。${TIME} 时 Mac 在睡觉的话，醒来后会补跑。
- 以后想移除：bash "${SRC}/uninstall.sh"

MSG
  exec bash "$HOME_DIR/scripts/jobhunt" console
fi
echo "完成。控制台：${HOME_DIR}/scripts/jobhunt console"
