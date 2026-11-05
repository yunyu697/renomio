#!/usr/bin/env bash
# macOS 应用签名（Hardened Runtime + 时间戳），并处理 sidecar 二进制的签名链。
#
# 用法：
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Team (TEAMID)" \
#   APPLE_TEAM_ID="TEAMID" \
#   ./scripts/sign/macos-sign.sh "src-tauri/target/release/bundle/macos/Renomio.app"
#
# 签名顺序（必须从内到外，否则公证会报 “signature invalid”）：
#   1. Contents/Frameworks 里的 dylib / framework
#   2. Contents/MacOS 里的 sidecar 可执行文件
#   3. 主可执行文件
#   4. .app 外层 Bundle
# 没有证书时打印接入说明并以退出码 3 结束，不会伪造签名成功。

set -euo pipefail

APP="${1:-}"
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
TEAM_ID="${APPLE_TEAM_ID:-}"
ENTITLEMENTS="${ENTITLEMENTS:-$(cd "$(dirname "$0")/../.." && pwd)/src-tauri/entitlements.plist}"

if [[ -z "$APP" ]]; then
  echo "用法：macos-sign.sh <path/to/App.app>" >&2
  exit 2
fi
if [[ ! -d "$APP" ]]; then
  echo "找不到应用包：$APP" >&2
  exit 2
fi
if [[ ! -f "$ENTITLEMENTS" ]]; then
  echo "找不到 entitlements：$ENTITLEMENTS" >&2
  exit 2
fi

if [[ -z "$IDENTITY" ]]; then
  cat >&2 <<'EOF'
未检测到 APPLE_SIGNING_IDENTITY，跳过 macOS 签名。
接入点：
  1) 在 Apple Developer 账号创建 “Developer ID Application” 证书并安装到钥匙串；
  2) security find-identity -v -p codesigning 查看完整身份名；
  3) export APPLE_SIGNING_IDENTITY="Developer ID Application: xxx (TEAMID)"；
  4) 公证另见 scripts/sign/macos-notarize.sh（notarytool 需要 App Store Connect API Key 或 Apple ID 应用专用密码）。
未签名的 .app 只能在本机运行，分发给他人会被 Gatekeeper 拦截。
EOF
  exit 3
fi

codesign_one() {
  local target="$1"
  local extra="${2:-}"
  echo "签名：$target"
  # shellcheck disable=SC2086
  codesign --force --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" ${extra} --sign "$IDENTITY" "$target"
}

APP_BIN="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
MAIN_BIN="$APP/Contents/MacOS/$APP_BIN"

echo "== 1/4 签名 Frameworks / dylib =="
if [[ -d "$APP/Contents/Frameworks" ]]; then
  while IFS= read -r -d '' nested; do
    # 跳过符号链接；框架目录本身由 codesign 递归处理
    if [[ -L "$nested" ]]; then continue; fi
    codesign_one "$nested"
  done < <(find "$APP/Contents/Frameworks" -type f \( -name '*.dylib' -o -path '*/Versions/*' \) -print0)
fi

echo "== 2/4 签名 sidecar / 辅助可执行文件 =="
if [[ -d "$APP/Contents/MacOS" ]]; then
  while IFS= read -r -d '' bin; do
    if [[ "$bin" == "$MAIN_BIN" ]]; then continue; fi
    codesign_one "$bin"
  done < <(find "$APP/Contents/MacOS" -maxdepth 1 -type f -perm -111 -print0)
fi
# 外部二进制若放在 Contents/Resources（externalBin 的旧布局），一并签名
if [[ -d "$APP/Contents/Resources" ]]; then
  while IFS= read -r -d '' bin; do
    codesign_one "$bin"
  done < <(find "$APP/Contents/Resources" -type f -perm -111 -print0)
fi

echo "== 3/4 签名主可执行文件 =="
codesign_one "$MAIN_BIN"

echo "== 4/4 签名 App Bundle =="
codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"

echo "== 校验 =="
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvvv --entitlements :- "$APP" 2>&1 | head -n 30 || true

if [[ -n "$TEAM_ID" ]]; then
  echo "Team ID：$TEAM_ID"
fi

echo "签名完成。下一步：scripts/sign/macos-notarize.sh \"$APP\""
