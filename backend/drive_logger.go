package backend

import (
	"context"
	"fmt"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// DriveLogger はログ出力を担当するインターフェース
type DriveLogger interface {
	Console(format string, args ...interface{})
	Info(format string, args ...interface{})
	Error(err error, format string, args ...interface{}) error
	ErrorWithNotify(err error, format string, args ...interface{}) error
}

// driveLoggerImpl はDriveLoggerの実装
type driveLoggerImpl struct {
	ctx context.Context
	isTestMode bool
}

// NewDriveLogger は新しいDriveLoggerインスタンスを作成
func NewDriveLogger(ctx context.Context, isTestMode bool) DriveLogger {
	return &driveLoggerImpl{
		ctx: ctx,
		isTestMode: isTestMode,
	}
}

// Console はログメッセージをコンソールのみに出力
func (l *driveLoggerImpl) Console(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Println(msg)
}

// Info は情報メッセージをコンソールとフロントエンドに出力
func (l *driveLoggerImpl) Info(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	fmt.Println(msg)
	l.sendLogMessage(msg)
}

// Error はエラーメッセージをコンソールとフロントエンドに出力し、エラーを返す
func (l *driveLoggerImpl) Error(err error, format string, args ...interface{}) error {
	msg := fmt.Sprintf(format, args...)
	errMsg := fmt.Sprintf("%s: %v", msg, err)
	fmt.Println(errMsg)
	l.sendLogMessage(errMsg)
	return fmt.Errorf("%s: %w", msg, err)
}

// ErrorWithNotify はエラーメッセージをコンソールとフロントエンドに出力し、
// さらにフロントエンドにエラー通知を送信
func (l *driveLoggerImpl) ErrorWithNotify(err error, format string, args ...interface{}) error {
	msg := fmt.Sprintf(format, args...)
	errMsg := fmt.Sprintf("%s: %v", msg, err)
	fmt.Println(errMsg)
	l.sendLogMessage(errMsg)
	
	if !l.isTestMode {
		wailsRuntime.EventsEmit(l.ctx, "drive:error", errMsg)
	}
	return fmt.Errorf("%s: %w", msg, err)
}

// sendLogMessage はログメッセージをフロントエンドに通知
func (l *driveLoggerImpl) sendLogMessage(message string) {
	if !l.isTestMode {
		wailsRuntime.EventsEmit(l.ctx, "logMessage", message)
	}
} 