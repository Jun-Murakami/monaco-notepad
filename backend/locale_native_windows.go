//go:build windows

package backend

import (
	"syscall"
	"unsafe"
)

const localeNameMaxLength = 85

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procGetUserDefaultLocaleName = kernel32.NewProc("GetUserDefaultLocaleName")
)

// detectNativeSystemLocale はWindowsのユーザーUIロケール（例: ja-JP, en-US）を返す。
func detectNativeSystemLocale() string {
	buffer := make([]uint16, localeNameMaxLength)
	result, _, _ := procGetUserDefaultLocaleName.Call(
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
	)

	if result == 0 {
		return ""
	}

	return syscall.UTF16ToString(buffer)
}
