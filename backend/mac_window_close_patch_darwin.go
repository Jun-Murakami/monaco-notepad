//go:build darwin

package backend

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework Foundation

#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#import <objc/message.h>

// 元の IMP を保持しておき、必要に応じてフォールバック呼び出しできるようにする。
static IMP originalWindowShouldCloseIMP = NULL;
static IMP originalApplicationShouldHandleReopenIMP = NULL;

static BOOL patchedWindowShouldClose(id self, SEL _cmd, id sender) {
	SEL hideOnCloseSelector = sel_registerName("hideOnClose");
	if (self != nil && [self respondsToSelector:hideOnCloseSelector]) {
		BOOL hideOnClose = ((BOOL(*)(id, SEL))objc_msgSend)(self, hideOnCloseSelector);
		if (hideOnClose) {
			if (sender != nil && [sender isKindOfClass:[NSWindow class]]) {
				[(NSWindow*)sender orderOut:nil];
			}
			[NSApp activateIgnoringOtherApps:YES];
			return NO;
		}
	}

	if (originalWindowShouldCloseIMP != NULL) {
		return ((BOOL(*)(id, SEL, id))originalWindowShouldCloseIMP)(self, _cmd, sender);
	}
	return NO;
}

static void patchWindowShouldClose(void) {
	Class cls = objc_getClass("WindowDelegate");
	if (cls == Nil) {
		return;
	}

	SEL selector = sel_registerName("windowShouldClose:");
	Method method = class_getInstanceMethod(cls, selector);
	if (method == NULL) {
		return;
	}

	IMP current = method_getImplementation(method);
	if (current == (IMP)patchedWindowShouldClose) {
		return;
	}

	originalWindowShouldCloseIMP = current;
	method_setImplementation(method, (IMP)patchedWindowShouldClose);
}

static BOOL patchedApplicationShouldHandleReopen(id self, SEL _cmd, id sender, BOOL hasVisibleWindows) {
	if (!hasVisibleWindows) {
		SEL mainWindowSelector = sel_registerName("mainWindow");
		if (self != nil && [self respondsToSelector:mainWindowSelector]) {
			id mainWindow = ((id(*)(id, SEL))objc_msgSend)(self, mainWindowSelector);
			if (mainWindow != nil && [mainWindow isKindOfClass:[NSWindow class]]) {
				[(NSWindow*)mainWindow makeKeyAndOrderFront:nil];
				[NSApp activateIgnoringOtherApps:YES];
				return YES;
			}
		}

		NSArray<NSWindow*> *windows = [NSApp windows];
		if ([windows count] > 0) {
			NSWindow *window = windows[0];
			if (window != nil) {
				[window makeKeyAndOrderFront:nil];
				[NSApp activateIgnoringOtherApps:YES];
				return YES;
			}
		}
	}

	if (originalApplicationShouldHandleReopenIMP != NULL) {
		return ((BOOL(*)(id, SEL, id, BOOL))originalApplicationShouldHandleReopenIMP)(self, _cmd, sender, hasVisibleWindows);
	}

	return YES;
}

static void patchApplicationShouldHandleReopen(void) {
	Class cls = objc_getClass("AppDelegate");
	if (cls == Nil) {
		return;
	}

	SEL selector = sel_registerName("applicationShouldHandleReopen:hasVisibleWindows:");
	Method method = class_getInstanceMethod(cls, selector);
	if (method == NULL) {
		class_addMethod(cls, selector, (IMP)patchedApplicationShouldHandleReopen, "B@:@B");
		return;
	}

	IMP current = method_getImplementation(method);
	if (current == (IMP)patchedApplicationShouldHandleReopen) {
		return;
	}

	originalApplicationShouldHandleReopenIMP = current;
	method_setImplementation(method, (IMP)patchedApplicationShouldHandleReopen);
}
*/
import "C"

// ApplyMacWindowClosePatch は macOS のみで有効な Objective-C ランタイムパッチを適用する。
// - 閉じるボタン押下時に hideOnClose を優先してウィンドウを非表示化
// - Dock から再オープン時に、不可視ウィンドウを前面表示する挙動を補正
func ApplyMacWindowClosePatch() {
	C.patchWindowShouldClose()
	C.patchApplicationShouldHandleReopen()
}
