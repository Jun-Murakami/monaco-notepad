//go:build windows

package backend

import (
	"syscall"
	"unsafe"
)

var (
	user32              = syscall.NewLazyDLL("user32.dll")
	procMonitorFromRect = user32.NewProc("MonitorFromRect")
)

// MONITOR_DEFAULTTONULL: ウィンドウ矩形がどのモニターとも重ならない場合 NULL を返す
const monitorDefaultToNull = 0x00000000

type winRect struct {
	Left, Top, Right, Bottom int32
}

// isWindowPositionValid は保存されたウィンドウ矩形が現在のモニター配置で
// 少なくとも一部が表示可能かどうかを返す。
func isWindowPositionValid(x, y, width, height int) bool {
	r := winRect{
		Left:   int32(x),
		Top:    int32(y),
		Right:  int32(x + width),
		Bottom: int32(y + height),
	}
	monitor, _, _ := procMonitorFromRect.Call(
		uintptr(unsafe.Pointer(&r)),
		uintptr(monitorDefaultToNull),
	)
	return monitor != 0
}
