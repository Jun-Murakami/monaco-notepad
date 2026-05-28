#!/usr/bin/env bash
#
# Monaco Notepad - Linux build script (WSL2 / Ubuntu 22.04+ 想定)
#
# 生成物:
#   build/bin/MonacoNotepad-linux-amd64-<ver>.AppImage
#   build/bin/monaco-notepad_<ver>_amd64.deb
#   build/bin/SHA256SUMS               (両方の SHA-256)
#   build/bin/SHA256SUMS.asc           (上記の GPG 署名 / 鍵がある時のみ)
#
# 前提パッケージ (Ubuntu 22.04 例):
#   sudo apt-get install -y build-essential pkg-config \
#       libgtk-3-dev libwebkit2gtk-4.0-dev \
#       dpkg-dev fakeroot file desktop-file-utils gpg
#   # Ubuntu 24.04+: libwebkit2gtk-4.1-dev を使う (自動検出)
#
#   # appimagetool は配布されていないので GitHub release から取得:
#   curl -L -o /usr/local/bin/appimagetool \
#     https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
#   chmod +x /usr/local/bin/appimagetool
#
# 環境変数 (.env から自動読み込み):
#   GPG_SIGNING_KEY  : 署名鍵 (鍵ID / FP / メール)。未指定なら gpg の既定鍵
#   SKIP_GPG_SIGN    : 'true' で SHA256SUMS のみ (署名スキップ)
#   WAILS_WEBKIT_TAG : '41' を指定すると -tags webkit2_41 で強制。
#                      省略時は pkg-config で自動検出
#
set -euo pipefail

# ---- .env 読み込み ---------------------------------------------------------
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

# ---- バージョン取得 --------------------------------------------------------
VERSION=$(grep -o '"productVersion": "[^"]*' wails.json | grep -o '[^"]*$')
if [ -z "$VERSION" ]; then
    echo "Error: failed to read productVersion from wails.json"
    exit 1
fi
echo "Building Monaco Notepad v$VERSION for Linux (amd64)..."

# ---- 必須ツールの確認 ------------------------------------------------------
require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Error: required command not found: $1"
        echo "$2"
        exit 1
    fi
}
require_cmd wails       "Install: https://wails.io/docs/gettingstarted/installation"
require_cmd node        "Install Node.js 20+"
require_cmd dpkg-deb    "Install: sudo apt-get install dpkg-dev"
require_cmd fakeroot    "Install: sudo apt-get install fakeroot"
require_cmd pkg-config  "Install: sudo apt-get install pkg-config"

# ---- WebKit2GTK バージョン検出 (4.0 / 4.1) ---------------------------------
# 環境変数で明示指定があればそちらを優先
WAILS_TAGS=()
if [ "${WAILS_WEBKIT_TAG:-}" = "41" ]; then
    WAILS_TAGS=(-tags webkit2_41)
    echo "  using -tags webkit2_41 (forced via WAILS_WEBKIT_TAG)"
elif pkg-config --exists webkit2gtk-4.0; then
    echo "  detected webkit2gtk-4.0 (default tag)"
elif pkg-config --exists webkit2gtk-4.1; then
    WAILS_TAGS=(-tags webkit2_41)
    echo "  detected webkit2gtk-4.1 → using -tags webkit2_41"
else
    echo "Error: neither webkit2gtk-4.0 nor webkit2gtk-4.1 dev packages were found."
    echo "Install one of:"
    echo "  sudo apt-get install libwebkit2gtk-4.0-dev   # Ubuntu 22.04"
    echo "  sudo apt-get install libwebkit2gtk-4.1-dev   # Ubuntu 24.04+"
    exit 1
fi

# ---- バージョン / ライセンス同期 -------------------------------------------
node scripts/sync-version.mjs
echo "Generating license information..."
(cd frontend && node scripts/generate-licenses.mjs)

# ---- Wails ビルド ----------------------------------------------------------
# 出力ファイル名は kebab-case で固定 (Linux 慣習 + .desktop の Exec= と揃える)
BIN_NAME="monaco-notepad"
BIN_DIR="build/bin"
BIN_PATH="$BIN_DIR/$BIN_NAME"

echo "Running wails build..."
rm -f "$BIN_PATH"
wails build \
    -platform linux/amd64 \
    -o "$BIN_NAME" \
    -ldflags "-X 'monaco-notepad/backend.Version=$VERSION'" \
    "${WAILS_TAGS[@]}"

if [ ! -f "$BIN_PATH" ]; then
    echo "Error: built binary not found at $BIN_PATH"
    exit 1
fi
chmod +x "$BIN_PATH"

# ---- 共通: 配置するアセット --------------------------------------------------
DESKTOP_FILE="build/linux/monaco-notepad.desktop"
ICON_SRC="build/appicon.png"

if [ ! -f "$DESKTOP_FILE" ]; then
    echo "Error: $DESKTOP_FILE not found"
    exit 1
fi
if [ ! -f "$ICON_SRC" ]; then
    echo "Error: $ICON_SRC not found"
    exit 1
fi

# ============================================================================
# AppImage 作成
# ============================================================================
APPIMAGE_NAME="MonacoNotepad-linux-amd64-${VERSION}.AppImage"
APPIMAGE_OUT="$BIN_DIR/$APPIMAGE_NAME"
APPDIR="$BIN_DIR/MonacoNotepad.AppDir"

echo ""
echo "==> Building AppImage..."
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/icons/hicolor/512x512/apps"

cp "$BIN_PATH" "$APPDIR/usr/bin/$BIN_NAME"
cp "$DESKTOP_FILE" "$APPDIR/usr/share/applications/$BIN_NAME.desktop"
cp "$ICON_SRC" "$APPDIR/usr/share/icons/hicolor/512x512/apps/$BIN_NAME.png"

# AppImage は .DirIcon と <name>.desktop をトップレベルに置く必要がある
cp "$DESKTOP_FILE" "$APPDIR/$BIN_NAME.desktop"
cp "$ICON_SRC" "$APPDIR/$BIN_NAME.png"
cp "$ICON_SRC" "$APPDIR/.DirIcon"

cp build/linux/AppRun "$APPDIR/AppRun"
chmod +x "$APPDIR/AppRun"

if command -v appimagetool >/dev/null 2>&1; then
    rm -f "$APPIMAGE_OUT"
    # WSL2 / docker / 一部 CI では FUSE が無いので --appimage-extract-and-run でも実行可
    ARCH=x86_64 appimagetool --no-appstream "$APPDIR" "$APPIMAGE_OUT"
    echo "  ✓ $APPIMAGE_OUT"
else
    echo "  ⚠ appimagetool not found — AppImage build skipped."
    echo "    Install:"
    echo "      sudo curl -L -o /usr/local/bin/appimagetool \\"
    echo "        https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
    echo "      sudo chmod +x /usr/local/bin/appimagetool"
    APPIMAGE_OUT=""
fi

# ============================================================================
# .deb 作成
# ============================================================================
DEB_ARCH="amd64"
DEB_NAME="${BIN_NAME}_${VERSION}_${DEB_ARCH}.deb"
DEB_OUT="$BIN_DIR/$DEB_NAME"

# ステージングは /tmp (ext4) を使う。WSL2 の /mnt/* (NTFS DrvFs) は metadata
# 無効のままだと chmod が効かず、mkdir 後のディレクトリが 0777 のままになり
# dpkg-deb の "control directory has bad permissions" で蹴られる。
DEB_STAGE=$(mktemp -d -t monaco-notepad-deb-XXXXXX)
trap 'rm -rf "$DEB_STAGE"' EXIT

echo ""
echo "==> Building .deb..."
mkdir -p "$DEB_STAGE/DEBIAN"
mkdir -p "$DEB_STAGE/usr/bin"
mkdir -p "$DEB_STAGE/usr/share/applications"
mkdir -p "$DEB_STAGE/usr/share/icons/hicolor/512x512/apps"

# control ファイルをテンプレートから生成
sed -e "s/__VERSION__/${VERSION}/g" \
    -e "s/__ARCH__/${DEB_ARCH}/g" \
    build/linux/deb-control.template > "$DEB_STAGE/DEBIAN/control"

install -m 0755 "$BIN_PATH" "$DEB_STAGE/usr/bin/$BIN_NAME"
install -m 0644 "$DESKTOP_FILE" "$DEB_STAGE/usr/share/applications/$BIN_NAME.desktop"
install -m 0644 "$ICON_SRC" "$DEB_STAGE/usr/share/icons/hicolor/512x512/apps/$BIN_NAME.png"

# 念のため明示的に dir/file 権限を合わせる (dpkg-deb は 0755 までしか許さない)
find "$DEB_STAGE" -type d -exec chmod 0755 {} +
chmod 0644 "$DEB_STAGE/DEBIAN/control"

rm -f "$DEB_OUT"
fakeroot dpkg-deb --build --root-owner-group "$DEB_STAGE" "$DEB_OUT"
echo "  ✓ $DEB_OUT"

# ============================================================================
# SHA256SUMS + GPG 署名
# ============================================================================
echo ""
echo "==> Generating checksums and signature..."
ARTIFACTS=()
[ -n "$APPIMAGE_OUT" ] && [ -f "$APPIMAGE_OUT" ] && ARTIFACTS+=("$APPIMAGE_OUT")
[ -f "$DEB_OUT" ] && ARTIFACTS+=("$DEB_OUT")

if [ ${#ARTIFACTS[@]} -eq 0 ]; then
    echo "Error: no artifacts produced"
    exit 1
fi

node scripts/sign-linux-artifacts.mjs "${ARTIFACTS[@]}"

# ============================================================================
# 完了
# ============================================================================
echo ""
echo "Build completed successfully!"
echo "Artifacts:"
for f in "${ARTIFACTS[@]}"; do
    echo "  - $f"
done
echo "  - $BIN_DIR/SHA256SUMS"
[ -f "$BIN_DIR/SHA256SUMS.asc" ] && echo "  - $BIN_DIR/SHA256SUMS.asc"
