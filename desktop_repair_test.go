package main

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestDesktopRepairRequiresConfirmationAndContinuesOnlyRequestedHistory(t *testing.T) {
	s := testStore(t)
	i := newImporter(s)
	job := desktopCaptureJob{ID: "repair", updated: 110}
	check(t, i.importDesktopCapture(job, liveTestResult(job.ID, false, "older-cursor", cacheMessage("recent", "user", "中间的问题", 109)), false))
	app := &App{Store: s, Importer: i}
	entered, release := make(chan struct{}), make(chan struct{})
	i.desktopRestore = func(context.Context) error {
		close(entered)
		<-release
		return nil
	}
	reads := 0
	i.desktopRead = func(_ context.Context, jobs []desktopCaptureJob, accept func(desktopCaptureResult) error) error {
		reads++
		if len(jobs) != 1 || jobs[0].ID != job.ID || jobs[0].Cursor != "older-cursor" {
			return errors.New("repair lost the requested conversation or its resume cursor")
		}
		return accept(liveTestResult(job.ID, true, "", cacheMessage("first", "user", "第一问", 101), cacheMessage("recent", "user", "中间的问题", 109)))
	}
	for _, body := range []string{`{}`, `{"session_id":"chatgpt:repair"}`, `{"confirmed":true,"session_id":"chatgpt:repair"}`} {
		if res := backupRequest(t, app, "POST", "/api/desktop-capture/repair", body); res.Code == 200 {
			t.Fatal("unconfirmed or disabled repair accepted", body)
		}
	}
	check(t, i.setDesktopCapture(true))
	res := backupRequest(t, app, "POST", "/api/desktop-capture/repair", `{"confirmed":true,"session_id":"chatgpt:repair"}`)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"started":true`) {
		t.Fatal(res.Body.String())
	}
	<-entered
	if i.status().Stage != "chatgpt_desktop_repair" || i.start(false) {
		t.Fatal("repair did not hold the shared sync lock", i.status())
	}
	res = backupRequest(t, app, "POST", "/api/desktop-capture/repair", `{"confirmed":true,"session_id":"chatgpt:repair"}`)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"started":false`) {
		t.Fatal("duplicate repair was started", res.Body.String())
	}
	close(release)
	report := waitSessionSync(t, i)
	if reads != 1 || len(report.Errors) != 0 || report.DesktopError != "" || report.SessionResult == nil || !report.SessionResult.Complete || report.SessionResult.Messages != 2 {
		t.Fatal("confirmed repair did not fill history", report)
	}
}

func TestDesktopRepairFailurePreservesMessagesAndCursor(t *testing.T) {
	s := testStore(t)
	i := newImporter(s)
	check(t, i.setDesktopCapture(true))
	job := desktopCaptureJob{ID: "repair-failure", updated: 110}
	check(t, i.importDesktopCapture(job, liveTestResult(job.ID, false, "keep-cursor", cacheMessage("q", "user", "已收录正文", 109)), false))
	i.desktopRestore = func(context.Context) error { return errors.New("无法恢复 Desktop") }
	i.desktopRead = func(context.Context, []desktopCaptureJob, func(desktopCaptureResult) error) error {
		return errors.New("reader must not run after failed repair")
	}
	started, err := i.startDesktopSync("chatgpt:"+job.ID, true)
	check(t, err)
	if !started {
		t.Fatal("repair did not start")
	}
	report := waitSessionSync(t, i)
	if len(report.Errors) != 1 || report.DesktopError != "无法恢复 Desktop" || report.SessionResult != nil || count(t, s, "messages") != 1 {
		t.Fatal("failed repair incorrectly succeeded or changed history", report)
	}
	checkpoint, err := one(s.DB, "SELECT value FROM settings WHERE key=?", desktopCheckpointPrefix+"chatgpt:"+job.ID)
	check(t, err)
	if !strings.Contains(str(checkpoint["value"]), "keep-cursor") {
		t.Fatal("failed repair discarded resume progress", checkpoint)
	}
}

func TestDesktopGlobalRepairAndOrdinarySyncDoNotRepeatRestarts(t *testing.T) {
	i := newImporter(testStore(t))
	check(t, i.setDesktopCapture(true))
	restarts := 0
	i.desktopRestore = func(context.Context) error { restarts++; return nil }
	i.desktopRead = func(_ context.Context, jobs []desktopCaptureJob, accept func(desktopCaptureResult) error) error {
		if jobs != nil {
			return errors.New("empty discovery should have no jobs")
		}
		return accept(desktopCaptureResult{Kind: "recent"})
	}
	started, err := i.startDesktopSync("", true)
	check(t, err)
	if !started {
		t.Fatal("global repair did not start")
	}
	report := waitSessionSync(t, i)
	if restarts != 1 || report.SessionID != "" || len(report.Errors)+len(report.Warnings) != 0 {
		t.Fatal("global repair failed", report)
	}
	i.captureDesktopChats(false)
	i.captureDesktopChats(true)
	if restarts != 1 {
		t.Fatal("ordinary or full sync restarted Desktop")
	}
}

func TestDesktopRepairLauncherFitsWindowsCommandLine(t *testing.T) {
	if len(encodedPowerShell("& {\n"+desktopStartScript+"\n} -Restart"))+200 >= 32767 {
		t.Fatal("embedded repair launcher exceeds the Windows command line limit")
	}
}
