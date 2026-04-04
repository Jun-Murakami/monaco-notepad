//go:build darwin

package backend

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// applyUpdate はmacOS用のアップデート処理を実行する
// DMGをマウント→.appをコピー→アンマウント→再起動
func (a *App) applyUpdate(dmgPath string) error {
	// 現在の実行ファイルから.appディレクトリを特定
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %w", err)
	}

	// 実行ファイルは Monaco Notepad.app/Contents/MacOS/Monaco Notepad にある
	appDir := exePath
	for !strings.HasSuffix(appDir, ".app") && appDir != "/" {
		appDir = filepath.Dir(appDir)
	}
	if !strings.HasSuffix(appDir, ".app") {
		return fmt.Errorf("could not determine .app directory from %s", exePath)
	}

	appName := filepath.Base(appDir)
	pid := os.Getpid()

	// シェルスクリプトを作成:
	// 1. アプリの終了を待機
	// 2. DMGをマウント
	// 3. .appをコピーして上書き
	// 4. DMGをアンマウント
	// 5. アプリを再起動
	// 6. クリーンアップ
	scriptPath := filepath.Join(os.TempDir(), "monaco_notepad_update.sh")
	script := fmt.Sprintf(`#!/bin/bash
# アプリの終了を待機
while kill -0 %d 2>/dev/null; do sleep 0.5; done
sleep 1

# DMGをマウント
MOUNT_OUTPUT=$(hdiutil attach "%s" -nobrowse -noverify 2>&1)
MOUNT_POINT=$(echo "$MOUNT_OUTPUT" | grep -o '/Volumes/.*' | head -1)

if [ -z "$MOUNT_POINT" ]; then
    osascript -e 'display dialog "Failed to mount update DMG." buttons {"OK"} default button "OK" with icon caution with title "Update Failed"'
    rm -f "%s"
    rm -f "%s"
    exit 1
fi

# .appをコピー
if [ -d "$MOUNT_POINT/%s" ]; then
    rm -rf "%s"
    cp -R "$MOUNT_POINT/%s" "%s"
else
    osascript -e 'display dialog "Application not found in DMG." buttons {"OK"} default button "OK" with icon caution with title "Update Failed"'
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null
    rm -f "%s"
    rm -f "%s"
    exit 1
fi

# DMGをアンマウント
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null

# クリーンアップ
rm -f "%s"

# アプリを再起動
open "%s"

# スクリプト自身を削除
rm -f "%s"
`, pid, dmgPath,
		dmgPath, scriptPath,
		appName, appDir, appName, appDir,
		dmgPath, scriptPath,
		dmgPath,
		appDir,
		scriptPath)

	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		return fmt.Errorf("failed to write update script: %w", err)
	}

	// シェルスクリプトをバックグラウンドで起動
	cmd := exec.Command("bash", scriptPath)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start update script: %w", err)
	}

	a.logger.Console("Update script started (PID: %d), quitting app...", cmd.Process.Pid)
	wailsRuntime.Quit(a.ctx.ctx)
	return nil
}
