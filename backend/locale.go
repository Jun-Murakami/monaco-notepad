package backend

import (
	"os"
	"strings"
)

// サポートされる言語
const (
	LocaleJapanese = "ja"
	LocaleEnglish  = "en"
	LocaleSystem   = "system"
)

// supportedLocales はサポートされる言語のセット
var supportedLocales = map[string]bool{
	LocaleJapanese: true,
	LocaleEnglish:  true,
}

// getNativeSystemLocale はOS依存のロケール取得処理を注入するための変数
var getNativeSystemLocale = detectNativeSystemLocale

// DetectSystemLocale はOSのシステムロケールを検出します
// 環境変数 LC_ALL, LC_MESSAGES, LANG を順にチェックし、未設定時はOS APIを使います
func DetectSystemLocale() string {
	// 優先順位順に環境変数をチェック
	keys := []string{"LC_ALL", "LC_MESSAGES", "LANG"}

	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return NormalizeLocale(value)
		}
	}

	// GUIアプリでは環境変数が空の場合があるため、OSネイティブAPIから取得する
	if value := strings.TrimSpace(getNativeSystemLocale()); value != "" {
		return NormalizeLocale(value)
	}

	// デフォルトは英語
	return LocaleEnglish
}

// NormalizeLocale はロケール文字列を正規化します
// 例: "ja_JP.UTF-8" → "ja", "en-US" → "en"
func NormalizeLocale(locale string) string {
	if locale == "" {
		return LocaleEnglish
	}

	// 小文字化
	locale = strings.ToLower(locale)

	// エンコーディング部分を削除（例: .UTF-8）
	if idx := strings.Index(locale, "."); idx != -1 {
		locale = locale[:idx]
	}

	// アンダースコアまたはハイフンで分割し、言語コード部分のみ取得
	locale = strings.Split(locale, "_")[0]
	locale = strings.Split(locale, "-")[0]

	// サポートされる言語かチェック
	if IsSupportedLocale(locale) {
		return locale
	}

	// サポート外の場合は英語にフォールバック
	return LocaleEnglish
}

// IsSupportedLocale は指定されたロケールがサポートされているか確認します
func IsSupportedLocale(locale string) bool {
	return supportedLocales[locale]
}

// GetSupportedLocales はサポートされる言語のリストを返します
func GetSupportedLocales() []string {
	return []string{LocaleEnglish, LocaleJapanese}
}

// GetDefaultLocale はデフォルトのロケールを返します
func GetDefaultLocale() string {
	return LocaleEnglish
}

// ResolveLocale は設定された言語を解決します
// "system" の場合はシステムロケールを返し、それ以外はそのまま返します
func ResolveLocale(uiLanguage string) string {
	if uiLanguage == LocaleSystem || uiLanguage == "" {
		return DetectSystemLocale()
	}
	return NormalizeLocale(uiLanguage)
}
