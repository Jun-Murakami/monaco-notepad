package backend

import (
	"context"
	"fmt"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// DriveLogger はログ出力とフロントエンド通知を担当するインターフェース
type DriveLogger interface {
	NotifyDriveStatus(ctx context.Context, status string)                // ドライブステータスの通知
	NotifyFrontendSyncedAndReload(ctx context.Context)                   // フロントエンドの変更通知
	Console(format string, args ...interface{})                          // コンソール出力
	Info(format string, args ...interface{})                             // 情報メッセージ出力
	Error(err error, format string, args ...interface{}) error           // エラーメッセージ出力
	ErrorWithNotify(err error, format string, args ...interface{}) error // エラーメッセージ出力とフロントエンド通知
	IsTestMode() bool
}

// driveLoggerImpl はDriveLoggerの実装
type driveLoggerImpl struct {
	ctx        context.Context
	isTestMode bool
}

// NewDriveLogger は新しいDriveLoggerインスタンスを作成
func NewDriveLogger(ctx context.Context, isTestMode bool) DriveLogger {
	return &driveLoggerImpl{
		ctx:        ctx,
		isTestMode: isTestMode,
	}
}

// ----------------------------------------------------------------
// ドライブステータスの通知
// ----------------------------------------------------------------

// ドライブの状態をフロントエンドに通知
func (l *driveLoggerImpl) NotifyDriveStatus(ctx context.Context, status string) {
	if !l.isTestMode {
		wailsRuntime.EventsEmit(l.ctx, "drive:status", status)
	}
}

// フロントエンドに変更を通知
func (l *driveLoggerImpl) NotifyFrontendSyncedAndReload(ctx context.Context) {
	if !l.isTestMode {
		wailsRuntime.EventsEmit(l.ctx, "notes:updated")
		wailsRuntime.EventsEmit(l.ctx, "drive:status", "synced")
		wailsRuntime.EventsEmit(l.ctx, "notes:reload")
	}
}

// ----------------------------------------------------------------
// ログメッセージの通知
// ----------------------------------------------------------------

// ログメッセージをコンソールのみに出力
func (l *driveLoggerImpl) Console(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	if !l.isTestMode {
		fmt.Println(message)
		l.sendLogMessage(message)
	}
}

// 情報メッセージをコンソールとフロントエンドに出力
func (l *driveLoggerImpl) Info(format string, args ...interface{}) {
	message := fmt.Sprintf(format, args...)
	if !l.isTestMode {
		fmt.Println(message)
		l.sendLogMessage(message)
	}
}

// エラーメッセージをコンソールとフロントエンドに出力し、エラーを返す
func (l *driveLoggerImpl) Error(err error, format string, args ...interface{}) error {
	if err == nil {
		return nil
	}

	message := fmt.Sprintf(format, args...)
	if !l.isTestMode {
		fmt.Printf("%s: %s\n", message, err.Error())
		l.sendLogMessage(fmt.Sprintf("%s: %s", message, err.Error()))
	}
	return err
}

// ErrorWithNotify はエラーメッセージをコンソールとフロントエンドに出力し、さらにフロントエンドにエラー通知を送信
func (l *driveLoggerImpl) ErrorWithNotify(err error, format string, args ...interface{}) error {
	if err == nil {
		return nil
	}

	message := fmt.Sprintf(format, args...)
	if !l.isTestMode {
		fmt.Printf("%s: %s\n", message, err.Error())
		l.sendLogMessage(fmt.Sprintf("%s: %s", message, err.Error()))
		wailsRuntime.EventsEmit(l.ctx, "drive:error", err.Error())
	}
	return err
}

// ログメッセージをフロントエンドのステータスバーに通知
func (l *driveLoggerImpl) sendLogMessage(message string) {
	if !l.isTestMode {
		wailsRuntime.EventsEmit(l.ctx, "logMessage", message)
	}
}

func (l *driveLoggerImpl) IsTestMode() bool {
	return l.isTestMode
}
