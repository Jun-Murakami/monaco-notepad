package main

import (
	"context"
	"embed"
	"os"
	"runtime"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/logger"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"

	"monaco-notepad/backend"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// macOS のウィンドウクローズ挙動パッチを適用する。
	// 実装は backend パッケージに集約し、main は起動シーケンスのみを担当する。
	backend.ApplyMacWindowClosePatch()

	// Create an instance of the app structure
	app := backend.NewApp()

	// コマンドライン引数を保存
	args := os.Args

	// Wailsアプリケーションを作成
	err := wails.Run(&options.App{
		Title:     "Monaco Notepad",
		Width:     1024,
		Height:    768,
		MinWidth:  720,
		MinHeight: 480,
		// macOSでは閉じるボタンでアプリを終了せず、Dockに残す
		HideWindowOnClose: runtime.GOOS == "darwin",
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
		OnStartup:        app.Startup,
		OnDomReady: func(ctx context.Context) {
			app.DomReady(ctx)
			// フロントエンドの準備が整ってから少し待ってからファイルを開く
			if len(args) > 1 {
				go func() {
					time.Sleep(500 * time.Millisecond)
					app.OpenFileFromExternal(args[1])
				}()
			}
		},
		OnBeforeClose: app.BeforeClose,
		LogLevel:      logger.INFO,
		Bind: []interface{}{
			app,
		},
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: false,
		},
		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: true,
				HideTitle:                  true,
			},
			OnFileOpen: func(filePath string) {
				app.OpenFileFromExternal(filePath)
			},
		},
		Debug: options.Debug{
			OpenInspectorOnStartup: false,
		},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "monaco-notepad-instance-lock",
			OnSecondInstanceLaunch: func(secondInstanceData options.SecondInstanceData) {
				app.BringToFront()

				if len(secondInstanceData.Args) > 0 {
					app.OpenFileFromExternal(secondInstanceData.Args[0])
				}
			},
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
