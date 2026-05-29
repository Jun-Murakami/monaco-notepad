//go:build !windows && !darwin

package backend

import "fmt"

// applyUpdate は未対応プラットフォーム用のスタブ
func (a *App) applyUpdate(assetPath string) error {
	return fmt.Errorf("auto-update is not supported on this platform")
}

// verifyUpdateSignature は未対応プラットフォーム用のスタブ。
// 自動更新自体が非対応なので、検証段階で更新を中止する。
func (a *App) verifyUpdateSignature(assetPath string) error {
	return fmt.Errorf("auto-update is not supported on this platform")
}
