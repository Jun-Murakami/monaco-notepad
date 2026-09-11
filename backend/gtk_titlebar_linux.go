//go:build linux

package backend

/*
#cgo linux pkg-config: gtk+-3.0
#include <gtk/gtk.h>

// アイドルコールバック。GTK メインループのスレッド上で実行されるため、
// 別 goroutine から呼んでも GtkSettings を安全に更新できる。
static gboolean monaco_apply_prefer_dark(gpointer data) {
	gboolean dark = (gboolean)(gintptr)data;
	GtkSettings *settings = gtk_settings_get_default();
	if (settings != NULL) {
		// CSD(クライアントサイド装飾)のタイトルバー色を決める GTK テーマの
		// ダーク変種を有効/無効にする。GNOME はこれを自動追従しない。
		g_object_set(settings, "gtk-application-prefer-dark-theme", dark, NULL);
	}
	return G_SOURCE_REMOVE; // 一度だけ実行
}

static void monaco_set_titlebar_dark(int dark) {
	// 別 goroutine からでも安全に GTK メインループへ処理を投げる。
	g_idle_add(monaco_apply_prefer_dark, (gpointer)(gintptr)(dark ? 1 : 0));
}
*/
import "C"

// setTitlebarDarkMode は GNOME などの GTK 環境で、タイトルバー(CSD)の
// ダーク/ライトをアプリのテーマ設定に追従させる。
// GTK 初期化(ウィンドウ生成)後に呼ばれる前提。
func setTitlebarDarkMode(dark bool) {
	v := C.int(0)
	if dark {
		v = C.int(1)
	}
	C.monaco_set_titlebar_dark(v)
}
