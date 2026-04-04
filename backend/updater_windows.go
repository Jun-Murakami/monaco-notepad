//go:build windows

package backend

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// applyUpdate はWindows用のアップデート処理を実行する
// NSISインストーラーをサイレント実行し、完了を待ってからアプリを再起動する
func (a *App) applyUpdate(installerPath string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %w", err)
	}

	installerName := filepath.Base(installerPath)

	// バッチスクリプトを作成:
	// 1. アプリの終了を待機
	// 2. NSISインストーラーをサイレント起動
	// 3. tasklist でインストーラーの終了をポーリング
	// 4. アプリを再起動
	scriptPath := filepath.Join(os.TempDir(), "monaco_notepad_update.bat")
	script := fmt.Sprintf(`@echo off
timeout /t 3 /nobreak >nul
start "" "%s" /S
timeout /t 5 /nobreak >nul
:waitloop
tasklist /fi "imagename eq %s" /nh 2>nul | find /i "%s" >nul 2>nul
if not errorlevel 1 (
    timeout /t 2 /nobreak >nul
    goto waitloop
)
timeout /t 2 /nobreak >nul
start "" "%s"
del "%s" 2>nul
del "%%~f0" 2>nul
`, installerPath, installerName, installerName, exePath, installerPath)

	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		return fmt.Errorf("failed to write update script: %w", err)
	}

	// CREATE_NO_WINDOW: 非表示コンソールを作成（パイプ操作が正常に動作する）
	cmd := exec.Command("cmd", "/c", scriptPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start update script: %w", err)
	}

	a.logger.Console("Update script started, quitting app...")
	wailsRuntime.Quit(a.ctx.ctx)
	return nil
}
