//go:build darwin

package backend

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation
#include <stdlib.h>
#import <Foundation/Foundation.h>

static char* DetectPreferredLanguage() {
	@autoreleasepool {
		NSArray<NSString *> *languages = [NSLocale preferredLanguages];
		if (languages == nil || [languages count] == 0) {
			return NULL;
		}

		NSString *first = [languages objectAtIndex:0];
		if (first == nil || [first length] == 0) {
			return NULL;
		}

		const char *utf8 = [first UTF8String];
		if (utf8 == NULL) {
			return NULL;
		}
		return strdup(utf8);
	}
}
*/
import "C"
import "unsafe"

// detectNativeSystemLocale はmacOSの優先言語（例: ja-JP, en-US）を返す。
func detectNativeSystemLocale() string {
	locale := C.DetectPreferredLanguage()
	if locale == nil {
		return ""
	}
	defer C.free(unsafe.Pointer(locale))
	return C.GoString(locale)
}
