package backend

import "testing"

func TestDetectSystemLocale_UsesEnvironmentVariablesFirst(t *testing.T) {
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "en_US.UTF-8")

	original := getNativeSystemLocale
	getNativeSystemLocale = func() string {
		return "ja-JP"
	}
	t.Cleanup(func() {
		getNativeSystemLocale = original
	})

	got := DetectSystemLocale()
	if got != LocaleEnglish {
		t.Fatalf("expected %q, got %q", LocaleEnglish, got)
	}
}

func TestDetectSystemLocale_UsesNativeLocaleWhenEnvMissing(t *testing.T) {
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "")

	original := getNativeSystemLocale
	getNativeSystemLocale = func() string {
		return "ja-JP"
	}
	t.Cleanup(func() {
		getNativeSystemLocale = original
	})

	got := DetectSystemLocale()
	if got != LocaleJapanese {
		t.Fatalf("expected %q, got %q", LocaleJapanese, got)
	}
}

func TestDetectSystemLocale_FallbacksToEnglish(t *testing.T) {
	t.Setenv("LC_ALL", "")
	t.Setenv("LC_MESSAGES", "")
	t.Setenv("LANG", "")

	original := getNativeSystemLocale
	getNativeSystemLocale = func() string {
		return ""
	}
	t.Cleanup(func() {
		getNativeSystemLocale = original
	})

	got := DetectSystemLocale()
	if got != LocaleEnglish {
		t.Fatalf("expected %q, got %q", LocaleEnglish, got)
	}
}
