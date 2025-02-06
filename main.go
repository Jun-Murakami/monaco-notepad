package main

import (
	"embed"

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
	// Create an instance of the app structure
	app := backend.NewApp()

	// Wailsアプリケーションを作成
	err := wails.Run(&options.App{
		Title:  "Monaco Notepad",
		Width:  1024,
		Height: 768,
		MinWidth: 720,
		MinHeight: 480,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
		OnStartup:        app.Startup,
		OnDomReady:       app.DomReady,
		OnBeforeClose:    app.BeforeClose,
		LogLevel: logger.INFO,
		Bind: []interface{}{
			app,
		},
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:       true,
			DisableWebViewDrop:   false,
		},
		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: true,
			},
			OnFileOpen: func(filePath string) {
				app.OpenFileFromExternal(filePath)
			},
		},
		Debug: options.Debug{
			OpenInspectorOnStartup: true,
		},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "monaco-notepad-instance-lock",
			OnSecondInstanceLaunch: func(secondInstanceData options.SecondInstanceData) {
				app.BringToFront()
				
				if len(secondInstanceData.Args) > 1 {
					app.OpenFileFromExternal(secondInstanceData.Args[1])
				}
			},
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
