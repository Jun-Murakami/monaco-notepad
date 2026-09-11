//go:build !linux

package backend

// setTitlebarDarkMode は Linux 以外では何もしない。
// macOS は mac.TitleBar、Windows は WindowSetDarkTheme で対応済み。
func setTitlebarDarkMode(dark bool) {}
