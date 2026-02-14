//go:build !darwin

package backend

// detectNativeSystemLocale はmacOS以外では環境変数に任せるため空文字を返す。
func detectNativeSystemLocale() string {
	return ""
}
