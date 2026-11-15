#!/usr/bin/env bash
# macOS 应用签名（从内到外），支持两种模式：
#   - 有 APPLE_SIGNING_IDENTITY：Developer ID 签名（Hardened Runtime + 时间戳），可继续公证
#   - 无 APPLE_SIGNING_IDENTITY：ad-hoc 签名（codesign -s -），供无证书环境分发/自测，**不能公证**
#
# 用法：
#   ./scripts/sign/macos-sign.sh "src-tauri/target/release/bundle/macos/Renomio.app"
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Team (TEAMID)" \
#   APPLE_TEAM_ID="TEAMID" \
#   ./scripts/sign/macos-sign.sh "src-tauri/target/release/bundle/macos/Renomio.app"
#   ./scripts/sign/macos-sign.sh --no-sign "…/Renomio.app"     # 完全跳过
#
# 签名顺序（必须从内到外，否则公证会报 “signature invalid”）：
#   1. Contents/Frameworks 里的 dylib / framework
#   2. Contents/MacOS 里的 sidecar 可执行文件
#   3. 主可执行文件
#   4. .app 外层 Bundle
#
# ad-hoc 签名能保证包内签名自洽（codesign --verify 通过），但没有 Apple 身份，
# 因此 Gatekeeper 仍会拦（spctl 显示 rejected），用户需手动放行，见 README。

set -euo pipefail

APP=""
DO_SIGN=1
for arg in "$@"; do
  case "$arg" in
    --no-sign) DO_SIGN=0 ;;
    -*) echo "未知参数：$arg" >&2; exit 2 ;;
    *)
      if [[ -n "$APP" ]]; then
        echo "只接受一个 .app 路径（多余参数：$arg）" >&2
        exit 2
      fi
      APP="$arg"
      ;;
  esac
done

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
TEAM_ID="${APPLE_TEAM_ID:-}"
ENTITLEMENTS="${ENTITLEMENTS:-$(cd "$(dirname "$0")/../.." && pwd)/src-tauri/entitlements.plist}"

if [[ "$DO_SIGN" == "0" ]]; then
  echo "已指定 --no-sign，跳过签名（产物未签名，分发后会被 Gatekeeper 拦截）。"
  exit 0
fi

if [[ -z "$APP" ]]; then
  echo "用法：macos-sign.sh [--no-sign] <path/to/App.app>" >&2
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

ADHOC=0
if [[ -z "$IDENTITY" ]]; then
  ADHOC=1
  cat >&2 <<'EOF'
未检测到 APPLE_SIGNING_IDENTITY，改用 ad-hoc 签名（codesign -s -）。
  - 产物可被 codesign --verify 校验通过，但 Gatekeeper 仍会拦截，用户需手动放行（见 README）。
  - 不能公证（macos-notarize.sh 需要 Apple 凭据）。
  - 若要正式分发：Apple Developer 账号申请 “Developer ID Application” 证书，安装到钥匙串后
    export APPLE_SIGNING_IDENTITY="Developer ID Application: xxx (TEAMID)" 再重跑本脚本。
EOF
fi

codesign_one() {
  local target="$1"
  echo "签名（$([[ "$ADHOC" == "1" ]] && echo ad-hoc || echo "$IDENTITY")）：$target"
  if [[ "$ADHOC" == "1" ]]; then
    # ad-hoc 不接受 --timestamp（没有可信时间源），也不带 Hardened Runtime
    codesign --force --entitlements "$ENTITLEMENTS" --sign - "$target"
  else
    codesign --force --timestamp --options runtime \
      --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$target"
  fi
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
codesign_one "$APP"

echo "== 校验 =="
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvvv "$APP" 2>&1 | head -n 20 || true

if [[ -n "$TEAM_ID" && "$ADHOC" != "1" ]]; then
  echo "Team ID：$TEAM_ID"
fi

if [[ "$ADHOC" == "1" ]]; then
  echo "ad-hoc 签名完成（无 Apple 身份）。Gatekeeper 校验预期为 rejected："
  spctl -a -vvv -t exec "$APP" 2>&1 || true
  echo "下一步：直接分发 dmg/zip，用户按 README 的 Gatekeeper 放行步骤安装。"
else
  echo "签名完成。下一步：scripts/sign/macos-notarize.sh \"$APP\""
fi
