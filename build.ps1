# Monaco Notepad - Windows build script
#
# フロー:
#   1. .env を読み込み (Azure Key Vault 認証情報など)
#   2. バージョン同期 + ライセンス生成
#   3. wails build -nsis でいったん exe + (未署名) installer を生成
#      ※ wails_tools.nsh を最新の productVersion で再生成する目的も兼ねる
#   4. 本体 exe を AzureSignTool で署名
#   5. makensis を直接呼んで「署名済み exe」を NSIS で再パッケージ
#   6. installer を AzureSignTool で署名
#   7. 最終ファイル名にリネーム
#
# 環境変数 (.env から読み込み可):
#   AZURE_KEY_VAULT_URL          (例: https://my-vault.vault.azure.net)
#   AZURE_KEY_VAULT_CLIENT_ID    Azure AD アプリの client id
#   AZURE_KEY_VAULT_CLIENT_SECRET (省略時は managed identity を試行)
#   AZURE_KEY_VAULT_TENANT_ID    Azure AD テナント id
#   AZURE_KEY_VAULT_CERTIFICATE  Key Vault 内の証明書名
#   AZURE_SIGN_TIMESTAMP_URL     (省略時 http://timestamp.digicert.com)
#   SKIP_WIN_SIGN=true           署名をスキップ (ローカル動作確認用)

$ErrorActionPreference = 'Stop'

# ---- .env 読み込み ----------------------------------------------------------
if (Test-Path '.env') {
    Get-Content '.env' | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#')) {
            $idx = $line.IndexOf('=')
            if ($idx -gt 0) {
                $key = $line.Substring(0, $idx).Trim()
                $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
                Set-Item -Path "Env:$key" -Value $value
            }
        }
    }
}

# ---- 設定 ------------------------------------------------------------------
$wailsConfig = Get-Content -Raw -Path 'wails.json' | ConvertFrom-Json
$version = $wailsConfig.info.productVersion
$projectName = $wailsConfig.name              # "Monaco Notepad"
$skipSign = ($env:SKIP_WIN_SIGN -eq 'true')

$binDir = 'build/bin'
$exePath = Join-Path $binDir "$projectName.exe"
$builtInstallerPattern = '*-amd64-installer.exe'
$targetInstallerName = "MonacoNotepad-win64-installer-$version.exe"
$targetInstallerPath = Join-Path $binDir $targetInstallerName

$timestampUrl = if ($env:AZURE_SIGN_TIMESTAMP_URL) { $env:AZURE_SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }

Write-Host "Building Monaco Notepad v$version for Windows..."
if ($skipSign) {
    Write-Host '⚠  SKIP_WIN_SIGN=true: code signing will be skipped.'
}

# ---- 署名ツールの検出 ------------------------------------------------------
function Get-AzureSignToolCommand {
    foreach ($name in @('AzureSignTool', 'azuresigntool')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    return $null
}

function Get-MakensisCommand {
    $cmd = Get-Command 'makensis' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallbacks = @(
        "$env:ProgramFiles\NSIS\makensis.exe",
        "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
    )
    foreach ($p in $fallbacks) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

function Invoke-AzureSign {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ToolPath
    )

    if (-not (Test-Path $Path)) {
        throw "Sign target not found: $Path"
    }

    $signArgs = @(
        'sign',
        '-kvu', $env:AZURE_KEY_VAULT_URL,
        '-kvt', $env:AZURE_KEY_VAULT_TENANT_ID,
        '-kvi', $env:AZURE_KEY_VAULT_CLIENT_ID,
        '-kvc', $env:AZURE_KEY_VAULT_CERTIFICATE,
        '-tr', $timestampUrl,
        '-td', 'sha256',
        '-fd', 'sha256',
        '-v'
    )
    # CLIENT_SECRET があればパスワード認証、無ければ managed identity (-kvm)
    if ($env:AZURE_KEY_VAULT_CLIENT_SECRET) {
        $signArgs += @('-kvs', $env:AZURE_KEY_VAULT_CLIENT_SECRET)
    } else {
        $signArgs += '-kvm'
    }
    $signArgs += $Path

    Write-Host "Signing: $Path"
    & $ToolPath @signArgs
    if ($LASTEXITCODE -ne 0) {
        throw "AzureSignTool failed (exit $LASTEXITCODE) for $Path"
    }
}

# ---- 事前検証 --------------------------------------------------------------
$azureSignTool = $null
$makensis = $null
if (-not $skipSign) {
    $azureSignTool = Get-AzureSignToolCommand
    if (-not $azureSignTool) {
        throw 'AzureSignTool が見つかりません。`dotnet tool install --global AzureSignTool` でインストールしてください (または SKIP_WIN_SIGN=true)。'
    }

    $required = @('AZURE_KEY_VAULT_URL', 'AZURE_KEY_VAULT_TENANT_ID', 'AZURE_KEY_VAULT_CLIENT_ID', 'AZURE_KEY_VAULT_CERTIFICATE')
    $missing = $required | Where-Object { -not (Get-Item "Env:$_" -ErrorAction SilentlyContinue).Value }
    if ($missing) {
        throw "必須の環境変数が未設定です: $($missing -join ', ')"
    }

    $makensis = Get-MakensisCommand
    if (-not $makensis) {
        throw 'makensis が見つかりません。NSIS をインストールするか、PATH に追加してください。'
    }
}

# ---- バージョン / ライセンス同期 -------------------------------------------
node scripts/sync-version.mjs
if ($LASTEXITCODE -ne 0) { throw 'Failed to sync version to package.json files' }

Write-Host 'Generating license information...'
Push-Location frontend
try {
    node scripts/generate-licenses.mjs
    if ($LASTEXITCODE -ne 0) { throw 'License generation failed' }
} finally {
    Pop-Location
}

# ---- 1st pass: wails build -nsis -------------------------------------------
# 目的:
#   a) 本体 exe を作る
#   b) wails_tools.nsh を最新の productVersion で再生成させる
# このパスで作られる installer は未署名なので使わずに破棄する。
Write-Host 'Wails build (1st pass: exe + regenerate NSIS tools)...'
wails build -ldflags "-X 'monaco-notepad/backend.Version=$version'" -platform windows/amd64 -nsis
if ($LASTEXITCODE -ne 0) { throw "wails build failed with exit code $LASTEXITCODE" }

if (-not (Test-Path $exePath)) {
    throw "Built exe not found: $exePath"
}

# 1st pass で出た未署名 installer は削除（後で署名版を作るため）
Get-ChildItem -Path $binDir -Filter $builtInstallerPattern -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

if ($skipSign) {
    Write-Host 'Re-running NSIS without signing (skip-sign mode)...'
} else {
    # ---- 本体 exe を署名 --------------------------------------------------
    Invoke-AzureSign -Path $exePath -ToolPath $azureSignTool
}

# ---- 2nd pass: makensis を直接呼んで署名済 exe を再パッケージ ---------------
$installerDir = Join-Path (Get-Location) 'build\windows\installer'
$projectNsi = Join-Path $installerDir 'project.nsi'
$wailsToolsNsh = Join-Path $installerDir 'wails_tools.nsh'

if (-not (Test-Path $projectNsi)) {
    throw "project.nsi not found at $projectNsi"
}
if (-not (Test-Path $wailsToolsNsh)) {
    throw "wails_tools.nsh not found at $wailsToolsNsh — wails build did not regenerate it"
}

# project.nsi は OutFile を `..\..\bin\${INFO_PROJECTNAME}-${ARCH}-installer.exe`
# として参照するので、makensis は installer ディレクトリで実行する必要がある。
$exeAbsPath = (Resolve-Path $exePath).Path
Write-Host 'Building NSIS installer with signed exe...'
Push-Location $installerDir
try {
    if ($makensis) {
        & $makensis "-DARG_WAILS_AMD64_BINARY=$exeAbsPath" 'project.nsi'
    } else {
        # skipSign 経路ではここに来る (makensis 未探索の場合に備えてもう一度探す)
        $m = Get-MakensisCommand
        if (-not $m) { throw 'makensis が見つかりません' }
        & $m "-DARG_WAILS_AMD64_BINARY=$exeAbsPath" 'project.nsi'
    }
    if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# ---- 生成された installer を特定 -------------------------------------------
$sourceInstallers = Get-ChildItem -Path $binDir -Filter $builtInstallerPattern -File -ErrorAction SilentlyContinue
if (-not $sourceInstallers -or $sourceInstallers.Count -eq 0) {
    throw "Installer was not produced in $binDir"
}
$sourceInstaller = $sourceInstallers | Sort-Object LastWriteTime -Descending | Select-Object -First 1

# ---- installer を署名 -------------------------------------------------------
if (-not $skipSign) {
    Invoke-AzureSign -Path $sourceInstaller.FullName -ToolPath $azureSignTool
}

# ---- リネーム --------------------------------------------------------------
if (Test-Path $targetInstallerPath) {
    Remove-Item -Path $targetInstallerPath -Force
}
Rename-Item -Path $sourceInstaller.FullName -NewName $targetInstallerName

Write-Host ''
Write-Host 'Build completed successfully!'
Write-Host "Output: $targetInstallerPath"
if (-not $skipSign) {
    Write-Host '  - signed: exe + installer (Azure Key Vault)'
}
