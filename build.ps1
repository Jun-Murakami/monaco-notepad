# wails.jsonからバージョン情報を取得
$wailsConfig = Get-Content -Raw -Path "wails.json" | ConvertFrom-Json
$version = $wailsConfig.info.productVersion

Write-Host "Building Monaco Notepad v$version for Windows..."

# バージョン情報を埋め込んでビルド
wails build -ldflags "-X 'monaco-notepad/backend.Version=$version'" -platform windows/amd64 -nsis

# ビルド成功時にメッセージを表示
if ($LASTEXITCODE -eq 0) {
    # リネーム後に使う最終的なファイル名を明示的に定義する。
    # 命名規則を1箇所に集約することで、将来変更時のメンテナンス性を上げる。
    $targetInstallerName = "MonacoNotepad-win64-installer-$version.exe"
    $targetInstallerPath = Join-Path "build/bin" $targetInstallerName

    # Wails/NSISの既定命名(例: Monaco Notepad-amd64-installer.exe)を前提に、
    # build/bin 配下から amd64 installer を検索する。
    # 将来的に outputfilename が変わっても、amd64-installer.exe であれば追従できるようにする。
    $sourceInstallers = Get-ChildItem -Path "build/bin" -Filter "*-amd64-installer.exe" -File

    if ($sourceInstallers.Count -eq 0) {
        Write-Host "Build completed successfully, but installer was not found in build/bin."
        exit 1
    }

    # 想定外に複数見つかった場合は、最終更新日時が新しいものを採用する。
    # 直近のビルド成果物を優先することで、過去成果物が残っていても誤動作を防ぐ。
    $sourceInstaller = $sourceInstallers | Sort-Object LastWriteTime -Descending | Select-Object -First 1

    # 同名ファイルが既に存在する場合は上書きできるように削除する。
    if (Test-Path $targetInstallerPath) {
        Remove-Item -Path $targetInstallerPath -Force
    }

    Rename-Item -Path $sourceInstaller.FullName -NewName $targetInstallerName

    Write-Host "Build completed successfully!"
    Write-Host "Output: $targetInstallerPath"
} else {
    Write-Host "Build failed with exit code $LASTEXITCODE"
} 