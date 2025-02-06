#!/bin/bash

# .envファイルの読み込み
export $(grep -v '^#' .env | xargs)

# アプリの署名
codesign --deep --force --verify --verbose --options runtime --sign "$DEVELOPER_ID_APP" "$APP_PATH"

# 既存のDMGファイルを削除
rm -f "$OUTPUT_PATH"/*.dmg

# dmgの作成と署名
create-dmg \
  --volname "$APP_NAME" \
  --window-pos 200 120 \
  --window-size 800 400 \
  --icon-size 100 \
  --icon "$APP_NAME.app" 200 190 \
  --hide-extension "$APP_NAME.app" \
  --app-drop-link 600 185 \
  --no-internet-enable \
  --format UDZO \
  --skip-jenkins \
  --codesign "$DEVELOPER_ID_APP" \
  "$OUTPUT_PATH/temp.dmg" \
  "$APP_PATH"

# 作成されたDMGファイルをリネーム
if [ -f "$OUTPUT_PATH/temp.dmg" ]; then
  echo "Found DMG: $OUTPUT_PATH/temp.dmg"
  mv "$OUTPUT_PATH/temp.dmg" "$OUTPUT_PATH/$APP_NAME-$VERSION.dmg"
  echo "Renamed to: $OUTPUT_PATH/$APP_NAME-$VERSION.dmg"
else
  echo "Error: Could not find created DMG file"
  exit 1
fi

# DMGファイルの権限を修正
chmod 644 "$OUTPUT_PATH/$APP_NAME-$VERSION.dmg"

# リソースフォークを削除
xattr -c "$OUTPUT_PATH/$APP_NAME-$VERSION.dmg"

echo "Submitting DMG for notarization..."
# ノータライズのリクエストとステータス確認
xcrun notarytool submit "$OUTPUT_PATH/$APP_NAME-$VERSION.dmg" \
  --apple-id "$APPLE_ID" \
  --password "$APP_SPECIFIC_PASSWORD" \
  --team-id "$TEAM_ID" \
  --wait \
  --timeout 3600 || {
    echo "Notarization failed"
    exit 1
  }

echo "Waiting for notarization to complete..."
sleep 30  # ノータライズの完了を待つ

echo "Stapling DMG..."
# ステープルの追加を試行（最大3回）
max_attempts=3
attempt=1
while [ $attempt -le $max_attempts ]; do
  if xcrun stapler staple "$OUTPUT_PATH/$APP_NAME-$VERSION.dmg"; then
    echo "Stapling successful!"
    break
  else
    echo "Stapling attempt $attempt failed"
    if [ $attempt -lt $max_attempts ]; then
      echo "Waiting before retry..."
      sleep 30
    fi
  fi
  attempt=$((attempt + 1))
done

if [ $attempt -gt $max_attempts ]; then
  echo "Failed to staple after $max_attempts attempts"
  exit 1
fi

echo "DMG creation and notarization completed successfully!"
xcrun stapler validate "$OUTPUT_PATH/$APP_NAME-$VERSION.dmg"