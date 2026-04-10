//go:build !windows

package backend

// isWindowPositionValid は非Windows環境ではモニター検証を行わず常にtrueを返す。
func isWindowPositionValid(x, y, width, height int) bool {
	return true
}
