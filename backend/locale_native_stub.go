//go:build !darwin && !windows

package backend

// detectNativeSystemLocale はmacOS/Windows以外では環境変数に任せるため空文字を返す。
func detectNativeSystemLocale() string {
	return ""
}
