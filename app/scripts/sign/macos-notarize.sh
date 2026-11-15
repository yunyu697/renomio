#!/usr/bin/env bash
# macOS 公证 + Staple
#
# 方式 A（推荐，CI / 本地均可）：App Store Connect API Key
#   APPLE_API_KEY="/path/AuthKey_XXXX.p8"
#   APPLE_API_KEY_ID="XXXX"
#   APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
#
# 方式 B：钥匙串里的 notarytool profile（先执行一次）
#   xcrun notarytool store-credentials "AC_NOTARY" \
#     --apple-id "you@example.com" --team-id "TEAMID" --password "app-specific-password"
#   NOTARY_PROFILE="AC_NOTARY"
#
# 方式 C：Apple ID + 应用专用密码
#   APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID
#
# 用法：./scripts/sign/macos-notarize.sh <App.app | Dmg.dmg | Zip.zip>
# 未提供任何凭据时以退出码 3 结束，不会伪造“已公证”。

set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" || ! -e "$TARGET" ]]; then
  echo "用法：macos-notarize.sh <path/to/artifact>" >&2
  exit 2
fi

WORK="$(mktemp -d)"
ARTIFACT="$TARGET"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# notarytool 只接受 .zip / .dmg / .pkg；.app 需要先 ditto 成 zip
if [[ -d "$TARGET" && "$TARGET" == *.app ]]; then
  ARTIFACT="$WORK/notarize.zip"
  echo "打包为 zip：$ARTIFACT"
  /usr/bin/ditto -c -k --keepParent "$TARGET" "$ARTIFACT"
fi

SUBMIT_ARGS=()
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  SUBMIT_ARGS=(--keychain-profile "$NOTARY_PROFILE")
elif [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
  SUBMIT_ARGS=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  SUBMIT_ARGS=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")
else
  cat >&2 <<'EOF'
未提供公证凭据，跳过公证。
接入点（任选其一）：
  A. APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER（App Store Connect API Key）
  B. 先 xcrun notarytool store-credentials "AC_NOTARY" ...，再设 NOTARY_PROFILE=AC_NOTARY
  C. APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID
未公证的签名应用在他人机器上仍会被 Gatekeeper 拦截。
EOF
  exit 3
fi

echo "提交公证（通常 2–10 分钟）…"
xcrun notarytool submit "$ARTIFACT" "${SUBMIT_ARGS[@]}" --wait

echo "Staple 到原始产物…"
xcrun stapler staple "$TARGET"
if [[ -d "$TARGET" ]]; then
  xcrun stapler validate "$TARGET"
else
  xcrun stapler validate "$TARGET"
fi

echo "验证 Gatekeeper："
spctl -a -vvv -t exec "$TARGET" || true
echo "公证完成。"
