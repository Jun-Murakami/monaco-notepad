//go:build darwin

package backend

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#include <stdlib.h>
#include <dispatch/dispatch.h>
#import <Cocoa/Cocoa.h>

static NSString* TranslateMenuTitle(NSString *title, BOOL isJa, NSString *appName) {
	if (title == nil) {
		return nil;
	}

	NSString *enHideApp = [NSString stringWithFormat:@"Hide %@", appName];
	NSString *jaHideApp = [NSString stringWithFormat:@"%@を隠す", appName];
	if ([title isEqualToString:enHideApp] || [title isEqualToString:jaHideApp]) {
		return isJa ? jaHideApp : enHideApp;
	}

	NSString *enQuitApp = [NSString stringWithFormat:@"Quit %@", appName];
	NSString *jaQuitApp = [NSString stringWithFormat:@"%@を終了", appName];
	if ([title isEqualToString:enQuitApp] || [title isEqualToString:jaQuitApp]) {
		return isJa ? jaQuitApp : enQuitApp;
	}

	NSArray<NSArray<NSString *> *> *pairs = @[
		@[@"Edit", @"編集"],
		@[@"Window", @"ウインドウ"],
		@[@"Hide Others", @"ほかを隠す"],
		@[@"Show All", @"すべてを表示"],
		@[@"Undo", @"取り消す"],
		@[@"Redo", @"やり直す"],
		@[@"Cut", @"切り取り"],
		@[@"Copy", @"コピー"],
		@[@"Paste", @"ペースト"],
		@[@"Paste and Match Style", @"ペーストしてスタイルを合わせる"],
		@[@"Delete", @"削除"],
		@[@"Select All", @"すべてを選択"],
		@[@"Speech", @"スピーチ"],
		@[@"Start Speaking", @"読み上げを開始"],
		@[@"Stop Speaking", @"読み上げを停止"],
		@[@"Writing Tools", @"作文ツール"],
		@[@"Show Writing Tools", @"作文ツールを表示"],
		@[@"Proofread", @"校正"],
		@[@"Rewrite", @"書き直し"],
		@[@"Make Friendly", @"親しみやすく"],
		@[@"Make Professional", @"プロフェッショナルに"],
		@[@"Make Concise", @"簡潔に"],
		@[@"Summarize", @"要約"],
		@[@"Create Key Points", @"要点を作成"],
		@[@"Make List", @"リストを作成"],
		@[@"Make Table", @"表を作成"],
		@[@"Compose...", @"作成..."],
		@[@"Compose…", @"作成..."],
		@[@"AutoFill", @"自動入力"],
		@[@"Contact...", @"連絡先..."],
		@[@"Contact…", @"連絡先..."],
		@[@"Passwords...", @"パスワード..."],
		@[@"Passwords…", @"パスワード..."],
		@[@"Start Dictation...", @"音声入力を開始..."],
		@[@"Start Dictation…", @"音声入力を開始..."],
		@[@"Emoji & Symbols", @"絵文字と記号"],
		@[@"Minimize", @"しまう"],
		@[@"Zoom", @"拡大/縮小"],
		@[@"Full Screen", @"フルスクリーンにする"],
	];

	for (NSArray<NSString *> *pair in pairs) {
		NSString *en = pair[0];
		NSString *ja = pair[1];
		if ([title isEqualToString:en] || [title isEqualToString:ja]) {
			return isJa ? ja : en;
		}
	}

	return nil;
}

static void LocalizeMenuRecursive(NSMenu *menu, BOOL isJa, NSString *appName) {
	if (menu == nil) {
		return;
	}

	for (NSMenuItem *item in [menu itemArray]) {
		NSString *translated = TranslateMenuTitle([item title], isJa, appName);
		if (translated != nil) {
			[item setTitle:translated];
		}

		NSMenu *submenu = [item submenu];
		if (submenu != nil) {
			LocalizeMenuRecursive(submenu, isJa, appName);
		}
	}
}

void LocalizeMainMenu(const char *localeC) {
	@autoreleasepool {
		NSString *locale = localeC ? [NSString stringWithUTF8String:localeC] : @"en";
		BOOL isJa = [locale hasPrefix:@"ja"];

		void (^work)(void) = ^{
			NSMenu *mainMenu = [NSApp mainMenu];
			if (mainMenu == nil) {
				return;
			}

			NSString *appName = [[NSRunningApplication currentApplication] localizedName];
			if (appName == nil || [appName length] == 0) {
				appName = [[NSProcessInfo processInfo] processName];
			}
			if (appName == nil || [appName length] == 0) {
				appName = @"Monaco Notepad";
			}

			LocalizeMenuRecursive(mainMenu, isJa, appName);
		};

		if ([NSThread isMainThread]) {
			work();
		} else {
			dispatch_async(dispatch_get_main_queue(), work);
		}
	}
}
*/
import "C"
import "unsafe"

func localizeNativeMenu(locale string) {
	if locale == "" {
		locale = LocaleEnglish
	}
	cLocale := C.CString(locale)
	defer C.free(unsafe.Pointer(cLocale))
	C.LocalizeMainMenu(cLocale)
}
