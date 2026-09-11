//go:build windows

package backend

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"
)

func TestVerifyUpdateSignatureWithoutPowerShellOnPath(t *testing.T) {
	// GUI アプリが PowerShell のない PATH を継承した環境を再現する。
	t.Setenv("PATH", t.TempDir())
	t.Setenv("PSModulePath", t.TempDir())
	path := filepath.Join(t.TempDir(), "更新 [1] ' $test.ps1")
	require.NoError(t, os.WriteFile(path, []byte("Write-Output 'unsigned'"), 0600))
	err := new(App).verifyUpdateSignature(path)
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		t.Logf("PowerShell stderr: %s", exitErr.Stderr)
	}
	// 検証コマンドが実際に動き、未署名ファイルは確実に拒否する。
	require.ErrorContains(t, err, `Authenticode signature status is "NotSigned"`)
}

func TestVerifyUpdateSignatureAcceptsSignedExecutable(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("PSModulePath", t.TempDir())
	systemDir, err := windows.GetSystemDirectory()
	require.NoError(t, err)
	// Windows 標準の署名済み PE を使い、インストーラと同じ検証経路を通す。
	data, err := os.ReadFile(filepath.Join(systemDir, "WindowsPowerShell", "v1.0", "powershell.exe"))
	require.NoError(t, err)
	path := filepath.Join(t.TempDir(), "更新 [1] ' $test.exe")
	require.NoError(t, os.WriteFile(path, data, 0600))
	require.NoError(t, new(App).verifyUpdateSignature(path))
}

func TestVerifyUpdateSignatureRejectsMissingFile(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	err := new(App).verifyUpdateSignature(filepath.Join(t.TempDir(), "missing.exe"))
	require.ErrorContains(t, err, "failed to verify Authenticode signature")
	var exitErr *exec.ExitError
	require.True(t, errors.As(err, &exitErr), "PowerShell must run and reject the missing file")
}
