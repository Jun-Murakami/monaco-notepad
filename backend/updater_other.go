//go:build !windows && !darwin

package backend

import "fmt"

// applyUpdate は未対応プラットフォーム用のスタブ
func (a *App) applyUpdate(assetPath string) error {
	return fmt.Errorf("auto-update is not supported on this platform")
}
