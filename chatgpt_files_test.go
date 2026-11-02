package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDesktopGeneratedFilesSurviveReimportMergeBackupAndDeletion(t *testing.T) {
	s := testStore(t)
	i := newImporter(s)
	ref := "sandbox:/workspace/scratch/test/珍珠奶茶_提示词.md"
	message := cacheMessage("file-message", "assistant", "[下载完整制作脚本（Markdown）]("+ref+")", 101)
	job := desktopCaptureJob{ID: "files"}
	capture := liveTestResult(job.ID, true, "", message)
	check(t, i.importDesktopCapture(job, capture, false))
	prepared, err := i.desktopImageJob(job)
	check(t, err)
	if len(prepared.Files) != 1 || prepared.Files[0].MessageID != "file-message" {
		t.Fatal("generated file was not queued with its owning message", prepared.Files)
	}
	raw := []byte("# 珍珠奶茶\n\n完整 41 镜头制作脚本。\n")
	result := desktopCaptureResult{ID: job.ID, Files: []desktopFile{{Reference: ref, Data: base64.StdEncoding.EncodeToString(raw)}}}
	check(t, i.importDesktopFiles(prepared, result))
	check(t, i.importDesktopFiles(prepared, result))
	check(t, i.importDesktopCapture(job, capture, false))
	prepared, err = i.desktopImageJob(job)
	check(t, err)
	if prepared.KnownFiles[ref] != hash(raw) || count(t, s, "assets") != 1 {
		t.Fatal("reimport lost file or repeated download duplicated bytes", prepared)
	}
	row, err := one(s.DB, "SELECT metadata FROM messages WHERE session_id=?", "chatgpt:"+job.ID)
	check(t, err)
	merged, err := mergeMetadata(`{"file_assets":{"other":{"id":"keep"}}}`, str(row["metadata"]))
	check(t, err)
	var metadata M
	check(t, json.Unmarshal([]byte(merged), &metadata))
	if len(obj(metadata["file_assets"])) != 2 {
		t.Fatal("backup merge lost generated file mappings")
	}
	app := &App{Store: s}
	t.Cleanup(app.backups.close)
	res := backupRequest(t, app, "GET", "/api/assets/"+hash(raw)+"?download="+url.QueryEscape("珍珠奶茶_提示词.md"), "")
	if res.Code != 200 || res.Body.String() != string(raw) || !strings.Contains(res.Header().Get("Content-Disposition"), "filename*=utf-8''") || !strings.Contains(res.Header().Get("Content-Type"), "text/plain") {
		t.Fatal("generated document cannot be opened or downloaded", res.Code, res.Header())
	}
	res = backupRequest(t, app, "POST", "/api/backup", `{"mode":"download"}`)
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	backup := awaitBackup(t, app)
	if backup.Stage != "ready" {
		t.Fatal(backup)
	}
	restoredPath := filepath.Join(t.TempDir(), "restored.sqlite")
	res = backupRequest(t, app, "GET", "/api/backup/download?id="+backup.ID, "")
	backupPath := filepath.Join(t.TempDir(), "backup.sqlite")
	check(t, os.WriteFile(backupPath, res.Body.Bytes(), 0600))
	check(t, restoreArchive(context.Background(), backupPath, restoredPath, nil))
	restored, err := openStore(restoredPath)
	check(t, err)
	defer restored.Close()
	res = backupRequest(t, &App{Store: restored}, "GET", "/api/assets/"+hash(raw), "")
	if res.Code != 200 || res.Body.String() != string(raw) {
		t.Fatal("restored document is unavailable offline")
	}
	check(t, s.deleteSession(context.Background(), "chatgpt:"+job.ID))
	check(t, i.importDesktopFiles(prepared, result))
	if count(t, s, "assets") != 0 {
		t.Fatal("late download resurrected a deleted file")
	}
}

func TestGeneratedFileReferencesNormalizeAndInvalidDownloadsRollBack(t *testing.T) {
	ref := "sandbox:/mnt/data/珍珠奶茶.md"
	encoded := "sandbox:/mnt/data/" + url.PathEscape("珍珠奶茶.md")
	sources := chatGPTFileSources("[下载]("+ref+")", M{"node_id": "message", "chatgpt_ui": M{"url": encoded}})
	if len(sources) != 1 || sources[0].Reference != ref {
		t.Fatal("encoded Chinese filename wasn't deduplicated", sources)
	}
	for _, invalid := range []string{"sandbox://host/file", "sandbox:/bad%ZZ", "sandbox:/bad%00"} {
		if sandboxReference(invalid) != "" {
			t.Fatal("invalid sandbox reference accepted", invalid)
		}
	}
	s := testStore(t)
	i := newImporter(s)
	job := desktopCaptureJob{ID: "files"}
	check(t, i.importDesktopCapture(job, liveTestResult(job.ID, true, "", cacheMessage("message", "assistant", "[下载]("+ref+")", 101)), false))
	err := i.importDesktopFiles(job, desktopCaptureResult{ID: job.ID, Files: []desktopFile{{ref, base64.StdEncoding.EncodeToString([]byte("valid"))}, {ref, "bad base64"}}})
	if err == nil || count(t, s, "assets") != 0 {
		t.Fatal("invalid response was partially committed")
	}
}

// Opt-in integration probe; only the supplied conversation and file are read.
func TestDesktopGeneratedFilesReadProbe(t *testing.T) {
	id, messageID, ref := os.Getenv("ECHO_DESKTOP_FILE_TEST_ID"), os.Getenv("ECHO_DESKTOP_FILE_TEST_MESSAGE"), os.Getenv("ECHO_DESKTOP_FILE_TEST_REF")
	if id == "" || messageID == "" || ref == "" {
		t.Skip("set an explicit Desktop generated-file probe")
	}
	if !desktopConversationID.MatchString(id) || sandboxReference(ref) == "" {
		t.Fatal("invalid probe reference")
	}
	i := newImporter(testStore(t))
	job := desktopCaptureJob{ID: id}
	check(t, i.importDesktopCapture(job, liveTestResult(id, true, "", cacheMessage(messageID, "assistant", "[文件]("+ref+")", int(now()))), false))
	job, err := i.desktopImageJob(job)
	check(t, err)
	check(t, readDesktopCapture(context.Background(), []desktopCaptureJob{job}, func(result desktopCaptureResult) error {
		if result.Kind == "images" {
			t.Logf("downloaded files=%d pending=%d", len(result.Files), result.PendingFiles)
			return i.importDesktopFiles(job, result)
		}
		if result.Kind == "unavailable" {
			return desktopUnavailable(result.Error)
		}
		return nil
	}))
	if count(t, i.Store, "assets") == 0 {
		t.Fatal("generated file was unavailable to the current Desktop login")
	}
}
