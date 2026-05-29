//go:build windows

package backend

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// verifyUpdateSignature はダウンロードしたインストーラの Authenticode 署名を
// 実行前に検証する。署名ステータスが "Valid" でない場合（未署名・改竄・失効・
// 信頼されない発行元）は fail-closed で更新を中止する。
// PowerShell の Get-AuthenticodeSignature を使い、信頼された CA チェーンと
// ファイル未改竄の両方を OS に検証させる。
func (a *App) verifyUpdateSignature(installerPath string) error {
	// -LiteralPath でワイルドカード展開を無効化し、パスを安全に渡す。
	psScript := "$ErrorActionPreference='Stop'; (Get-AuthenticodeSignature -LiteralPath $args[0]).Status.ToString()"
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", psScript, installerPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to verify Authenticode signature: %w", err)
	}
	status := strings.TrimSpace(string(out))
	if status != "Valid" {
		return fmt.Errorf("Authenticode signature status is %q (expected Valid)", status)
	}
	return nil
}

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
