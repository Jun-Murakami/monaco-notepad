//go:build !darwin

package backend

// ApplyMacWindowClosePatch は macOS 以外の環境では何もしない。
// main 側の起動コードを OS 分岐から解放するため、No-Op 実装を用意する。
func ApplyMacWindowClosePatch() {}
