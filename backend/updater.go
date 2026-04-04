package backend

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// ReleaseInfo はGitHubリリースの情報を保持する
type ReleaseInfo struct {
	Version     string `json:"version"`
	Body        string `json:"body"`
	DownloadURL string `json:"downloadUrl"`
	AssetName   string `json:"assetName"`
}

const githubRepo = "Jun-Murakami/monaco-notepad"

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
	tmpDir := os.TempDir()
	tmpPath := filepath.Join(tmpDir, assetName)

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
	wailsRuntime.EventsEmit(a.ctx.ctx, "update:progress", "installing")

	// BeforeClose処理をスキップして即座に終了できるようにする
	a.ctx.SkipBeforeClose(true)

	return a.applyUpdate(tmpPath)
}
