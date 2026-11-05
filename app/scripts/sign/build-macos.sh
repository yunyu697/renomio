#!/usr/bin/env bash
# macOS 发布构建（.app + .dmg），签名 / 公证按需执行。
#
# 用法：
#   ./scripts/sign/build-macos.sh              # 未签名构建
#   APPLE_SIGNING_IDENTITY="Developer ID Application: ..." ./scripts/sign/build-macos.sh
#   APPLE_SIGNING_IDENTITY=... NOTARY_PROFILE=AC_NOTARY ./scripts/sign/build-macos.sh --notarize

set -euo pipefail

DO_NOTARIZE=0
[[ "${1:-}" == "--notarize" ]] && DO_NOTARIZE=1

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

npm run tauri build -- --bundles app,dmg

APP="$(find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit)"
DMG="$(find src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -print -quit)"

if [[ -z "$APP" ]]; then
  echo '未找到 .app 产物' >&2
  exit 1
fi

SIGNED=0
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  if ./scripts/sign/macos-sign.sh "$APP"; then
    SIGNED=1
    # Tauri 打包 dmg 时使用构建出的 .app；先构建后签名，需要重打 dmg 才会包含签名后的应用
    if [[ -z "$DMG" ]]; then
      DMG="src-tauri/target/release/bundle/dmg/Renomio_0.1.0_aarch64.dmg"
      mkdir -p "$(dirname "$DMG")"
    fi
    hdiutil create -volname "Renomio" -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null
    echo "已重新打包 dmg：$DMG"
  else
    echo '签名失败，保留未签名产物。' >&2
  fi
else
  ./scripts/sign/macos-sign.sh "$APP" || true
fi

if [[ "$DO_NOTARIZE" == "1" ]]; then
  if [[ "$SIGNED" != "1" ]]; then
    echo '未签名，无法公证。' >&2
    exit 3
  fi
  ./scripts/sign/macos-notarize.sh "$APP"
  if [[ -n "$DMG" && -f "$DMG" ]]; then
    ./scripts/sign/macos-notarize.sh "$DMG"
  fi
fi

echo ''
echo '产物：'
[[ -n "$APP" ]] && shasum -a 256 "$APP/Contents/MacOS/"* 2>/dev/null || true
[[ -n "$DMG" && -f "$DMG" ]] && shasum -a 256 "$DMG"
