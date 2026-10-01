#!/usr/bin/env bash
# (Re)installs the daily launchd job. Usage: schedule.sh [HH:MM]   default 08:00.
# Runs at the chosen time and again 20, 40 and 90 minutes later; those retries do nothing once today is done, and only
# really run when an earlier slot failed (for example the network was not back yet after waking from sleep).
# JOBHUNT_LABEL names the job (tests and sandboxes MUST set their own, or they would replace the real one).
set -euo pipefail
HOME_DIR="${JOBHUNT_HOME:-$HOME/.n8n-job-hunter}"
if [ -n "${JOBHUNT_RUNTIME:-}" ]; then RUNTIME="$JOBHUNT_RUNTIME"; elif [ -f "$HOME_DIR/runtime-path" ]; then RUNTIME="$(cat "$HOME_DIR/runtime-path")"; else RUNTIME="$HOME_DIR"; fi
LABEL="${JOBHUNT_LABEL:-com.cc-workspace.n8n-job-hunter}"
TIME="${1:-08:00}"
die() { echo "ERROR: $*" >&2; exit 1; }
case "$TIME" in [0-2][0-9]:[0-5][0-9]) ;; *) die "时间格式应为 HH:MM" ;; esac
HOUR=$((10#${TIME%%:*})); MIN=$((10#${TIME##*:})); [ "$HOUR" -le 23 ] || die "小时应为 00-23"
[ -f "$HOME_DIR/scripts/hunt.mjs" ] || die "还没安装：先运行 install.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"; mkdir -p "$HOME/Library/LaunchAgents" "$HOME_DIR/logs"
SLOTS=""
for extra in 0 20 40 90; do t=$((HOUR * 60 + MIN + extra)); [ "$t" -lt 1440 ] || continue
  SLOTS="$SLOTS<dict><key>Hour</key><integer>$((t / 60))</integer><key>Minute</key><integer>$((t % 60))</integer></dict>"; done
cat > "$PLIST.new" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$RUNTIME/.runtime/node/bin/node</string><string>$HOME_DIR/scripts/hunt.mjs</string><string>--scheduled</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>JOBHUNT_HOME</key><string>$HOME_DIR</string>
    <key>JOBHUNT_RUNTIME</key><string>$RUNTIME</string>
    <key>PATH</key><string>$RUNTIME/.runtime/node/bin:$RUNTIME/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key><array>$SLOTS</array>
  <key>StandardOutPath</key><string>$HOME_DIR/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/launchd.log</string>
</dict></plist>
PLISTEOF
plutil -lint "$PLIST.new" >/dev/null || { rm -f "$PLIST.new"; die "生成的 plist 无效"; }
mv "$PLIST.new" "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "定时任务已安装：每天 ${TIME}（之后 20/40/90 分钟是补跑时段）"
