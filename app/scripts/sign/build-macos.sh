#!/usr/bin/env bash
# macOS 发布构建（.app + .dmg）；签名 / 公证按环境自动选择：
#   - 无 APPLE_SIGNING_IDENTITY：ad-hoc 签名（codesign -s -），产物可下载安装但需用户放行 Gatekeeper
#   - 有 APPLE_SIGNING_IDENTITY：Developer ID 签名，可加 --notarize 走公证
#
# 用法：
#   ./scripts/sign/build-macos.sh              # 无证书：构建 + ad-hoc 签名 + 重打 dmg
#   APPLE_SIGNING_IDENTITY="Developer ID Application: ..." ./scripts/sign/build-macos.sh
#   APPLE_SIGNING_IDENTITY=... NOTARY_PROFILE=AC_NOTARY ./scripts/sign/build-macos.sh --notarize

set -euo pipefail

DO_NOTARIZE=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --notarize) DO_NOTARIZE=1 ;;
    --no-build) SKIP_BUILD=1 ;; # CI 已构建过时复用现有产物，只做签名 + 重打 dmg
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ "$SKIP_BUILD" == "1" ]]; then
  echo '已指定 --no-build：跳过 tauri build，直接对现有产物签名。'
else
  # 未配置 updater 私钥时关闭 updater 产物：否则 tauri build 会在产出安装包后
  # 因「有公钥无私钥」以退出码 1 结束（包是完整的，但 CI 会误判失败）。
  CONFIG_ARGS=()
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    CONFIG_ARGS=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
    echo '未配置 TAURI_SIGNING_PRIVATE_KEY：本次不生成 updater 产物（.sig / .tar.gz）。'
  fi

  npm run tauri build -- --bundles app,dmg "${CONFIG_ARGS[@]}"
fi

APP="$(find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit)"
DMG="$(find src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' -print -quit)"

if [[ -z "$APP" ]]; then
  echo '未找到 .app 产物' >&2
  exit 1
fi

MODE='ad-hoc'
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  MODE='developer-id'
fi

if ! ./scripts/sign/macos-sign.sh "$APP"; then
  echo '签名失败，保留未签名产物。' >&2
  exit 4
fi

if [[ "$DO_NOTARIZE" == "1" && "$MODE" != 'developer-id' ]]; then
  echo '当前为 ad-hoc 签名（无 Apple 身份），不能公证。' >&2
  echo '若要公证：export APPLE_SIGNING_IDENTITY="Developer ID Application: ..." 后重跑。' >&2
  exit 3
fi

# Tauri 打包 dmg 时用的是构建出的 .app；签名发生在其后，必须重打 dmg 才会包含签名后的应用
if [[ -z "$DMG" ]]; then
  mkdir -p src-tauri/target/release/bundle/dmg
  DMG="src-tauri/target/release/bundle/dmg/$(basename "${APP%.app}").dmg"
fi
rm -f "$DMG"
# 用临时目录保留 dmg 的标准布局（应用 + /Applications 快捷方式），否则只能拖到桌面再手动移动
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Renomio" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "已用签名后的 .app 重新打包 dmg：$DMG"

if [[ "$DO_NOTARIZE" == "1" ]]; then
  ./scripts/sign/macos-notarize.sh "$DMG"
fi

echo ''
echo "产物（$MODE 签名）："
shasum -a 256 "$APP/Contents/MacOS/"* 2>/dev/null || true
shasum -a 256 "$DMG"
if [[ "$MODE" == 'ad-hoc' ]]; then
  echo ''
  echo 'ad-hoc 签名的包没有 Apple 身份，分发给他人后 Gatekeeper 会拦截，用户需手动放行（见 README）。'
fi
