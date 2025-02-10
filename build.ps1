# wails.jsonからバージョン情報を取得
$wailsConfig = Get-Content -Raw -Path "wails.json" | ConvertFrom-Json
$version = $wailsConfig.info.productVersion

Write-Host "Building Monaco Notepad v$version for Windows..."

# バージョン情報を埋め込んでビルド
wails build -ldflags "-X 'monaco-notepad/backend.Version=$version'" -platform windows/amd64 -nsis

# ビルド成功時にメッセージを表示
if ($LASTEXITCODE -eq 0) {
    Write-Host "Build completed successfully!"
    Write-Host "Output: build/bin/Monaco Notepad.exe"
} else {
    Write-Host "Build failed with exit code $LASTEXITCODE"
} 