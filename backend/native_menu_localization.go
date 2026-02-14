package backend

// applyNativeMenuLocalization はUI言語設定に基づいてネイティブメニューの表示言語を切り替える。
func (a *App) applyNativeMenuLocalization(uiLanguage string) {
	locale := ResolveLocale(uiLanguage)
	localizeNativeMenu(locale)
}
