#!/bin/bash
# 用 macOS 自带的 hdiutil 把 .app 封装成 dmg。
#
# 为什么不用 electron-builder 的 dmg target：
# 它内部依赖 dmgbuild（自带一份 Python），在 GitHub 的 macOS 14 runner 上会报
# plistlib.InvalidFileException，导致整个打包失败。hdiutil 是系统命令，没有这层依赖。
#
# 用法（在 macOS 上，先 npm run package:mac 生成 .app）：
#   bash scripts/make-dmg.sh
set -euo pipefail

APP_NAME="详情图工作台"
VERSION="$(node -p "require('./package.json').version")"

made=0
for pair in "arm64:dist/mac-arm64" "x64:dist/mac"; do
  arch="${pair%%:*}"
  dir="${pair#*:}"
  app_path="$dir/$APP_NAME.app"
  if [ ! -d "$app_path" ]; then
    echo "跳过 $arch：没有找到 $app_path"
    continue
  fi

  stage="$(mktemp -d)"
  cp -R "$app_path" "$stage/"
  ln -s /Applications "$stage/Applications"

  out="dist/Detail-Image-Studio-${VERSION}-mac-${arch}.dmg"
  rm -f "$out"
  echo "封装 $arch -> $out"
  hdiutil create -volname "$APP_NAME" -srcfolder "$stage" -ov -format UDZO "$out"
  rm -rf "$stage"
  made=$((made + 1))
done

if [ "$made" -eq 0 ]; then
  echo "没有生成任何 dmg：先跑 npm run package:mac" >&2
  exit 1
fi

echo "完成，共产出 $made 个 dmg："
ls -lh dist/*.dmg
