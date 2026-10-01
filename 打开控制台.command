#!/bin/bash
# Double-click to open the console in the browser (the same as running: ~/.n8n-job-hunter/scripts/jobhunt console).
# Keep this window open while you use the console; closing it closes the console.
home="${JOBHUNT_HOME:-$HOME/.n8n-job-hunter}"
if [ ! -x "$home/scripts/jobhunt" ]; then echo "还没有安装求职助手（找不到 $home/scripts/jobhunt）：请先双击「双击安装.command」或运行 install.sh。"; read -r -p "按回车关闭" _; exit 1; fi
exec bash "$home/scripts/jobhunt" console
