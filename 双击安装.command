#!/bin/bash
# Double-click installer (from the zip). It copies its own folder to ~/n8n-job-hunter first (the zip may sit in a deep
# folder of a chat app), then runs install.sh there.
here="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/n8n-job-hunter"
if [ "$here" != "$dest" ]; then
  if [ -e "$dest" ] && [ ! -f "$dest/install.sh" ]; then echo "${dest} 已经存在，但不是这个项目的文件夹。请先改名或移走它。"; read -r -p "按回车关闭" _; exit 1; fi
  if [ -d "$dest/.git" ]; then echo "${dest} 是一个 git 仓库（开发用的副本），不会覆盖它：请在里面直接运行 ./install.sh，或先把它改名。"; read -r -p "按回车关闭" _; exit 1; fi
  rm -rf "$dest.old"; [ -e "$dest" ] && mv "$dest" "$dest.old"
  cp -R "$here" "$dest" && rm -rf "$dest.old"
fi
chmod u+x "$dest"/*.sh "$dest"/scripts/*.sh "$dest"/scripts/jobhunt 2>/dev/null
exec bash "$dest/install.sh"
