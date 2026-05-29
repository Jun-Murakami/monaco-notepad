package backend

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// ReleaseInfo はGitHubリリースの情報を保持する。
//
// Manual=true のときは「アプリ内自動アップデートは行わず、ユーザーをダウンロード
// ページに飛ばして手動更新してもらう」モード。Linux ビルド (.deb / AppImage) は
// パッケージ更新に root 権限や AppImage の zsync が必要で、アプリ単独でのバイナリ
// 差し替えが安全に行えないためこの経路を使う。
// このとき DownloadURL / AssetName は空、ManualURL に配布ページの URL が入る。
type ReleaseInfo struct {
	Version     string `json:"version"`
	Body        string `json:"body"`
	DownloadURL string `json:"downloadUrl"`
	AssetName   string `json:"assetName"`
	Manual      bool   `json:"manual"`
	ManualURL   string `json:"manualUrl"`
}

const githubRepo = "Jun-Murakami/monaco-notepad"

// manualUpdateURL は Linux 等で「アプリ内では更新できないので外部のダウンロード
// ページを開く」場合の遷移先。
const manualUpdateURL = "https://jun-murakami.web.app/apps/monaco-notepad"

// GetReleaseInfo はGitHub APIから最新リリース情報を取得する
func (a *App) GetReleaseInfo() (*ReleaseInfo, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", githubRepo)

	resp, err := http.Get(url)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch release info: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned status %d", resp.StatusCode)
	}

	var release struct {
		TagName string `json:"tag_name"`
		Body    string `json:"body"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, fmt.Errorf("failed to parse release info: %w", err)
	}

	version := strings.TrimPrefix(release.TagName, "v")

	// Linux はパッケージング (.deb / AppImage) の都合上アプリ内自動更新を行わず、
	// 配布ページに誘導する。リリースノート (Body) は表示したいので、ここで早期 return。
	if runtime.GOOS == "linux" {
		return &ReleaseInfo{
			Version:   version,
			Body:      release.Body,
			Manual:    true,
			ManualURL: manualUpdateURL,
		}, nil
	}

	// 現在のプラットフォームに対応するアセットを検索
	var assetName, downloadURL string
	for _, asset := range release.Assets {
		switch runtime.GOOS {
		case "windows":
			if strings.Contains(asset.Name, "win64") && strings.HasSuffix(asset.Name, ".exe") {
				assetName = asset.Name
				downloadURL = asset.BrowserDownloadURL
			}
		case "darwin":
			if strings.Contains(asset.Name, "mac") && strings.HasSuffix(asset.Name, ".dmg") {
				assetName = asset.Name
				downloadURL = asset.BrowserDownloadURL
			}
		}
	}

	if downloadURL == "" {
		return nil, fmt.Errorf("no compatible asset found for %s", runtime.GOOS)
	}

	return &ReleaseInfo{
		Version:     version,
		Body:        release.Body,
		DownloadURL: downloadURL,
		AssetName:   assetName,
	}, nil
}

// PerformUpdate はアップデートをダウンロードして適用する
func (a *App) PerformUpdate(downloadURL, assetName string) error {
	if err := validateUpdateDownload(downloadURL, assetName); err != nil {
		return err
	}
	tmpDir := os.TempDir()
	tmpPath := filepath.Join(tmpDir, filepath.Base(assetName))

	a.logger.Console("Downloading update: %s", downloadURL)
	wailsRuntime.EventsEmit(a.ctx.ctx, "update:progress", "downloading")

	// ダウンロード
	resp, err := http.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("failed to download update: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned status %d", resp.StatusCode)
	}

	out, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}

	totalSize := resp.ContentLength
	written := int64(0)
	buf := make([]byte, 32*1024)

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				out.Close()
				os.Remove(tmpPath)
				return fmt.Errorf("failed to write update file: %w", writeErr)
			}
			written += int64(n)
			if totalSize > 0 {
				percent := int(float64(written) / float64(totalSize) * 100)
				wailsRuntime.EventsEmit(a.ctx.ctx, "update:download-progress", percent)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			out.Close()
			os.Remove(tmpPath)
			return fmt.Errorf("failed to read update data: %w", readErr)
		}
	}
	out.Close()

	a.logger.Console("Download complete: %s (%d bytes)", tmpPath, written)

	// ダウンロードしたバイナリの完全性・真正性を実行前に検証する（2 層）。
	// URL は HTTPS + GitHub リポジトリにピン留め済み。その上で:
	//
	//  1. SHA-256 チェックサム検証 (verifyUpdateChecksum):
	//     リリースに併載した <asset>.sha256 と照合し、ダウンロード破損や部分的な
	//     改竄を捕捉する。チェックサムはバイナリと同じリリースにあるため「完全性」
	//     は担保するが「真正性」は担保しない（リリースごと差し替えられたら共に偽装
	//     されうる）。.sha256 が無い旧リリースでは skip する（署名検証で守る）。
	//
	//  2. コード署名検証 (verifyUpdateSignature):
	//     Authenticode (Windows) / codesign + notarization (macOS) を検証する。
	//     攻撃者は署名鍵なしに有効な署名を偽造できないため、リリースアセットや配布
	//     アカウントが侵害された場合でも改竄/差し替えされたインストーラを弾ける（真正性）。
	//
	// いずれか一方でも失敗したら fail-closed で更新を中止する。
	wailsRuntime.EventsEmit(a.ctx.ctx, "update:progress", "verifying")
	if err := a.verifyUpdateChecksum(tmpPath, downloadURL); err != nil {
		os.Remove(tmpPath)
		a.logger.Console("Update checksum verification failed: %v", err)
		return fmt.Errorf("update checksum verification failed: %w", err)
	}
	if err := a.verifyUpdateSignature(tmpPath); err != nil {
		os.Remove(tmpPath)
		a.logger.Console("Update signature verification failed: %v", err)
		return fmt.Errorf("update signature verification failed: %w", err)
	}
	a.logger.Console("Update verified (checksum + signature): %s", tmpPath)

	wailsRuntime.EventsEmit(a.ctx.ctx, "update:progress", "installing")

	// BeforeClose処理をスキップして即座に終了できるようにする
	a.ctx.SkipBeforeClose(true)

	return a.applyUpdate(tmpPath)
}

// verifyUpdateChecksum はリリースに併載された "<asset>.sha256" を取得し、
// ダウンロードしたファイルの SHA-256 と照合する。チェックサムが見つからない
// (404) 場合は、旧リリース互換のため検証を skip する（署名検証側で守る）。
// 不一致や取得失敗（404 以外）は fail-closed でエラーにする。
func (a *App) verifyUpdateChecksum(filePath, downloadURL string) error {
	checksumURL := downloadURL + ".sha256"
	// downloadURL は validateUpdateDownload 済み。.sha256 も同じ GitHub リリース
	// パス配下なので追加検証は不要だが、念のためスキーム/ホストを再確認する。
	if parsed, err := url.Parse(checksumURL); err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" {
		return fmt.Errorf("invalid checksum URL")
	}

	resp, err := http.Get(checksumURL)
	if err != nil {
		return fmt.Errorf("failed to fetch checksum: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		// このリリースにはチェックサムが無い（旧リリース）。署名検証に委ねる。
		a.logger.Console("No .sha256 published for this release; skipping checksum verification")
		return nil
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("checksum download returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if err != nil {
		return fmt.Errorf("failed to read checksum: %w", err)
	}
	expected := parseSHA256Hex(string(body))
	if expected == "" {
		return fmt.Errorf("could not parse sha256 from checksum file")
	}

	actual, err := fileSHA256(filePath)
	if err != nil {
		return err
	}
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("sha256 mismatch: expected %s, got %s", expected, actual)
	}
	return nil
}

// fileSHA256 はファイルの SHA-256 を 16 進小文字で返す。
func fileSHA256(filePath string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to open file: %w", err)
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("failed to hash file: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// parseSHA256Hex は sha256sum 形式 ("<hex>  <filename>") または素の 16 進文字列から
// 64 文字の SHA-256 16 進ダイジェストを取り出す。見つからなければ空文字を返す。
func parseSHA256Hex(content string) string {
	for _, field := range strings.Fields(content) {
		if len(field) == 64 && isHex(field) {
			return strings.ToLower(field)
		}
	}
	return ""
}

func isHex(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func validateUpdateDownload(downloadURL, assetName string) error {
	parsed, err := url.Parse(downloadURL)
	if err != nil {
		return fmt.Errorf("invalid update URL: %w", err)
	}
	if parsed.Scheme != "https" || parsed.Host != "github.com" {
		return fmt.Errorf("update URL must be an HTTPS GitHub release asset URL")
	}
	expectedPrefix := fmt.Sprintf("/%s/releases/download/", githubRepo)
	if !strings.HasPrefix(parsed.EscapedPath(), expectedPrefix) {
		return fmt.Errorf("update URL is not from the configured repository")
	}
	if assetName == "" || filepath.Base(assetName) != assetName {
		return fmt.Errorf("invalid update asset name")
	}
	switch runtime.GOOS {
	case "windows":
		if !strings.Contains(assetName, "win64") || !strings.HasSuffix(assetName, ".exe") {
			return fmt.Errorf("update asset does not match Windows package naming")
		}
	case "darwin":
		if !strings.Contains(assetName, "mac") || !strings.HasSuffix(assetName, ".dmg") {
			return fmt.Errorf("update asset does not match macOS package naming")
		}
	default:
		return fmt.Errorf("updates are not supported on %s", runtime.GOOS)
	}
	return nil
}
