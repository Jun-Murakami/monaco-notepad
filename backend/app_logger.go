package backend

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// AppLogger はログ出力とフロントエンド通知を担当するインターフェース
type AppLogger interface {
	NotifyDriveStatus(ctx context.Context, status string)                // ドライブステータスの通知
	NotifyFrontendSyncedAndReload(ctx context.Context)                   // フロントエンドの変更通知
	Console(format string, args ...interface{})                          // コンソール出力
	Info(format string, args ...interface{})                             // 情報メッセージ出力
	Error(err error, format string, args ...interface{}) error           // エラーメッセージ出力
	ErrorWithNotify(err error, format string, args ...interface{}) error // エラーメッセージ出力とフロントエンド通知
	IsTestMode() bool
	SetDebugMode(isDebug bool) // デバッグモードの設定
}

// appLoggerImpl はAppLoggerの実装
type appLoggerImpl struct {
	ctx        context.Context
	isTestMode bool
	logFile    *os.File
	logDir     string
	isDebug    bool
}

// NewAppLogger は新しいAppLoggerインスタンスを作成
func NewAppLogger(ctx context.Context, isTestMode bool, appDataDir string) AppLogger {
	logDir := filepath.Join(appDataDir, "logs")
	os.MkdirAll(logDir, 0755)

	return &appLoggerImpl{
		ctx:        ctx,
		isTestMode: isTestMode,
		logDir:     logDir,
		isDebug:    false,
	}
}

// SetDebugMode はデバッグモードを設定し、必要に応じてログファイルを開く/閉じる
func (l *appLoggerImpl) SetDebugMode(isDebug bool) {
	if l.isDebug == isDebug {
		return
	}

	l.isDebug = isDebug

	// 現在のログファイルを閉じる
	if l.logFile != nil {
		l.logFile.Close()
		l.logFile = nil
	}

	// デバッグモードがオンの場合、新しいログファイルを開く
	if isDebug {
		logPath := filepath.Join(l.logDir, fmt.Sprintf("app_%s.log", time.Now().Format("2006-01-02_15-04-05")))
		logFile, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			fmt.Printf("Error opening log file: %v\n", err)
			return
		}
		l.logFile = logFile
	}
}

// writeToLog はログファイルに書き込みを行う
func (l *appLoggerImpl) writeToLog(message string) {
	if l.logFile != nil && l.isDebug {
		timestamp := time.Now().Format("2006-01-02 15:04:05")
		logMessage := fmt.Sprintf("[%s] %s\n", timestamp, message)
		if _, err := l.logFile.WriteString(logMessage); err != nil {
			fmt.Printf("Error writing to log file: %v\n", err)
		}
	}
}

// ----------------------------------------------------------------
// ドライブステータスの通知
// ----------------------------------------------------------------

// ドライブの状態をフロントエンドに通知
func (l *appLoggerImpl) NotifyDriveStatus(ctx context.Context, status string) {
	if !l.isTestMode {
		wailsRuntime.EventsEmit(l.ctx, "drive:status", status)
	}
}

// フロントエンドに同期完了を通知してリロード
func (l *appLoggerImpl) NotifyFrontendSyncedAndReload(ctx context.Context) {
	if !l.isTestMode {
		wailsRuntime.EventsEmit(l.ctx, "notes:updated")
		wailsRuntime.EventsEmit(l.ctx, "notes:reload")
	}
}

// ----------------------------------------------------------------
// ログメッセージの通知
// ----------------------------------------------------------------

// ログメッセージをコンソールのみに出力
func (l *appLoggerImpl) Console(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	if !l.isTestMode {
		fmt.Println(message)
		l.writeToLog(message)
	}
}

// 情報メッセージをコンソールとフロントエンドに出力
func (l *appLoggerImpl) Info(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	if !l.isTestMode {
		fmt.Println(message)
		l.writeToLog(message)
		l.sendLogMessage(message)
	}
}

// エラーメッセージをコンソールとフロントエンドに出力し、エラーを返す
func (l *appLoggerImpl) Error(err error, format string, args ...interface{}) error {
	if err == nil {
		return nil
	}

	message := fmt.Sprintf(format, args...)
	if !l.isTestMode {
		errorMessage := fmt.Sprintf("%s: %s", message, err.Error())
		fmt.Println(errorMessage)
		l.writeToLog(errorMessage)
		l.sendLogMessage(errorMessage)
	}
	return err
}

// ErrorWithNotify はエラーメッセージをコンソールとフロントエンドに出力し、さらにフロントエンドにエラー通知を送信
func (l *appLoggerImpl) ErrorWithNotify(err error, format string, args ...interface{}) error {
	if err == nil {
		return nil
	}

	message := fmt.Sprintf(format, args...)
	if !l.isTestMode {
		errorMessage := fmt.Sprintf("%s: %s", message, err.Error())
		fmt.Println(errorMessage)
		l.writeToLog(errorMessage)
		l.sendLogMessage(errorMessage)
		wailsRuntime.EventsEmit(l.ctx, "drive:error", err.Error())
	}
	return err
}

// ログメッセージをフロントエンドのステータスバーに通知
func (l *appLoggerImpl) sendLogMessage(message string) {
	if !l.isTestMode {
		wailsRuntime.EventsEmit(l.ctx, "logMessage", message)
	}
}

func (l *appLoggerImpl) IsTestMode() bool {
	return l.isTestMode
}
