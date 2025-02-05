#!/bin/bash

# .envファイルの読み込み
set -a
source .env
set +a

# DMGファイル名を設定
DMG_NAME="${APP_NAME// /_}_$VERSION.dmg"

# アプリの署名
codesign --deep --force --verify --verbose --options runtime --sign "$DEVELOPER_ID_APP" "$APP_PATH"

# dmgの作成と署名
create-dmg \
  --volname "$APP_NAME" \
  --window-pos 200 120 \
  --window-size 800 400 \
  --icon-size 100 \
  --icon "$APP_NAME.app" 200 190 \
  --hide-extension "$APP_NAME.app" \
  --app-drop-link 600 185 \
  "$OUTPUT_PATH/$DMG_NAME" \
  "$APP_PATH"

# 一時ファイルの名前を修正
mv "$OUTPUT_PATH"/rw.*.dmg "$OUTPUT_PATH/$DMG_NAME"

# ノータライズのリクエスト
xcrun notarytool submit "$OUTPUT_PATH/$DMG_NAME" --apple-id "$APPLE_ID" --password "$APP_SPECIFIC_PASSWORD" --team-id "$TEAM_ID" --force

sleep 20

# ノータライズの確認とステープルの追加
xcrun stapler staple "$OUTPUT_PATH/$DMG_NAME"