package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestLauncherScripts(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the WSL/Linux launcher uses /proc and ss")
	}
	for _, name := range []string{"bash", "ss"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skipf("%s is unavailable", name)
		}
	}
	root := t.TempDir()
	binary := filepath.Join(root, "built-vault")
	build := exec.Command("go", "build", "-buildvcs=false", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build launcher fixture: %v\n%s", err, output)
	}
	payload, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	newProject := func(t *testing.T, name string) string {
		t.Helper()
		project := filepath.Join(root, name)
		for _, dir := range []string{"bin", "scripts", "browser-stubs"} {
			if err := os.MkdirAll(filepath.Join(project, dir), 0700); err != nil {
				t.Fatal(err)
			}
		}
		for _, name := range []string{"start-gpt-vault.sh", "start-echo-vault.sh"} {
			source, err := os.ReadFile(filepath.Join("scripts", name))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(project, "scripts", name), source, 0700); err != nil {
				t.Fatal(err)
			}
		}
		for _, name := range []string{"powershell.exe", "xdg-open"} {
			if err := os.WriteFile(filepath.Join(project, "browser-stubs", name), []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(filepath.Join(project, "bin", "gpt-vault"), payload, 0700); err != nil {
			t.Fatal(err)
		}
		return project
	}
	command := func(project string, port int) *exec.Cmd {
		cmd := exec.Command("bash", filepath.Join(project, "scripts", "start-echo-vault.sh"), "--port", strconv.Itoa(port), "--data", filepath.Join(project, "echo.sqlite"))
		cmd.Env = append(os.Environ(), "PATH="+filepath.Join(project, "browser-stubs")+string(os.PathListSeparator)+os.Getenv("PATH"))
		return cmd
	}
	freePort := func(t *testing.T) int {
		t.Helper()
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		listener.Close()
		return port
	}
	waitReady := func(t *testing.T, child *launcherChild, port int) {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			select {
			case err := <-child.done:
				t.Fatalf("launcher exited before becoming ready: %v\n%s", err, child.output.String())
			default:
			}
			if gptVaultRunning(fmt.Sprintf("http://127.0.0.1:%d", port)) {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("launcher did not become ready")
	}

	t.Run("legacy shortcut starts and restarts a replaced binary", func(t *testing.T) {
		project, port := newProject(t, "project with spaces"), freePort(t)
		first := startLauncherChild(t, command(project, port))
		waitReady(t, first, port)
		// Go builds replace the executable while the old instance is running.
		replacement := filepath.Join(project, "bin", "replacement")
		if err := os.WriteFile(replacement, payload, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(replacement, filepath.Join(project, "bin", "gpt-vault")); err != nil {
			t.Fatal(err)
		}
		second := startLauncherChild(t, command(project, port))
		select {
		case err := <-first.done:
			if err != nil {
				t.Fatalf("old instance did not shut down cleanly: %v\n%s", err, first.output.String())
			}
		case <-time.After(15 * time.Second):
			t.Fatal("old instance was not restarted")
		}
		waitReady(t, second, port)
	})

	t.Run("another project's listener is left running", func(t *testing.T) {
		foreign, target, port := newProject(t, "foreign"), newProject(t, "target"), freePort(t)
		other := startLauncherChild(t, command(foreign, port))
		waitReady(t, other, port)
		cmd := command(target, port)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		guarded := exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
		guarded.Env = cmd.Env
		output, err := guarded.CombinedOutput()
		if err == nil || !strings.Contains(string(output), "another application or another project") {
			t.Fatalf("expected port ownership error, got %v\n%s", err, output)
		}
		waitReady(t, other, port)
	})
}

type launcherChild struct {
	output bytes.Buffer
	done   chan error
}

func startLauncherChild(t *testing.T, cmd *exec.Cmd) *launcherChild {
	t.Helper()
	child := &launcherChild{done: make(chan error, 1)}
	cmd.Stdout, cmd.Stderr = &child.output, &child.output
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { child.done <- cmd.Wait(); close(child.done) }()
	t.Cleanup(func() {
		select {
		case <-child.done:
			return
		default:
		}
		cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-child.done:
		case <-time.After(5 * time.Second):
			cmd.Process.Kill()
			<-child.done
		}
	})
	return child
}
