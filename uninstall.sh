#!/usr/bin/env bash
# Removes the daily schedule. With --purge it also deletes JOBHUNT_HOME (your profile, settings, history, reports and the
# runtime this project installed for itself). A runtime that belongs to another project is never touched.
set -euo pipefail
HOME_DIR="${JOBHUNT_HOME:-$HOME/.n8n-job-hunter}"
LABEL="${JOBHUNT_LABEL:-com.cc-workspace.n8n-job-hunter}"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"; echo "定时任务已移除"
if command -v pmset >/dev/null 2>&1 && pmset -g sched 2>/dev/null | grep -q wakeorpoweron; then echo "提示：电脑还有定时唤醒设置（当初为求职助手设的话，可以取消）：sudo pmset repeat cancel"; fi
pkill -f "$HOME_DIR/scripts/console.mjs" 2>/dev/null || true
if [ "${1:-}" = "--purge" ]; then
  [ -n "$HOME_DIR" ] && [ "$HOME_DIR" != "/" ] && [ "$HOME_DIR" != "$HOME" ] || { echo "拒绝删除：路径不安全（${HOME_DIR}）" >&2; exit 1; }
  rm -rf "$HOME_DIR"; echo "运行目录已删除（含你的资料、记录和这个项目自己装的 Node/n8n）"
else
  echo "运行目录保留（含你的资料和记录）；加 --purge 才会删除：bash uninstall.sh --purge"
fi
