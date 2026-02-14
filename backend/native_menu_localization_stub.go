//go:build !darwin

package backend

// localizeNativeMenu はmacOS以外では何もしない。
func localizeNativeMenu(_ string) {}
