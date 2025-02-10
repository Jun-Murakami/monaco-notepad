#!/bin/bash

# .envファイルの読み込み
if [ -f .env ]; then
    set -a
    source .env
    set +a
else
    echo "Error: .env file not found"
    exit 1
fi

# wails.jsonからバージョン情報を取得
VERSION=$(cat wails.json | grep -o '"productVersion": "[^"]*' | grep -o '[^"]*$')
echo "Building Monaco Notepad v$VERSION for macOS..."

# ユニバーサルバイナリのビルド
wails build -ldflags "-X 'monaco-notepad/backend.Version=$VERSION'" -platform darwin/universal

if [ $? -ne 0 ]; then
    echo "Build failed!"
    exit 1
fi

echo "Build completed successfully!"

# アプリの署名
echo "Signing application..."
codesign --deep --force --verify --verbose --options runtime --sign "$DEVELOPER_ID_APP" "build/bin/Monaco Notepad.app"

# DMGの作成
echo "Creating DMG..."
create-dmg \
  --volname "Monaco Notepad" \
  --window-pos 200 120 \
  --window-size 800 400 \
  --icon-size 100 \
  --icon "Monaco Notepad.app" 200 190 \
  --hide-extension "Monaco Notepad.app" \
  --app-drop-link 600 185 \
  --format UDZO \
  --skip-jenkins \
  --codesign "$DEVELOPER_ID_APP" \
  "build/bin/Monaco Notepad-mac-universal-$VERSION.dmg" \
  "build/bin/Monaco Notepad.app"

# DMGファイルの権限を修正
chmod 644 "build/bin/Monaco Notepad-mac-universal-$VERSION.dmg"
xattr -c "build/bin/Monaco Notepad-mac-universal-$VERSION.dmg"

echo "Submitting DMG for notarization..."
xcrun notarytool submit "build/bin/Monaco Notepad-mac-universal-$VERSION.dmg" \
  --keychain-profile monaconotepad \
  --wait

echo "Waiting for notarization to complete..."
sleep 30

echo "Stapling DMG..."
max_attempts=3
attempt=1
while [ $attempt -le $max_attempts ]; do
    if xcrun stapler staple "build/bin/Monaco Notepad-mac-universal-$VERSION.dmg"; then
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

echo "Validating DMG..."
xcrun stapler validate "build/bin/Monaco Notepad-mac-universal-$VERSION.dmg"

echo "Build and notarization completed successfully!"
echo "Output: build/bin/Monaco Notepad-mac-universal-$VERSION.dmg" 