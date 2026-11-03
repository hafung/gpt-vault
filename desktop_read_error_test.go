package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestDesktopConversationReadErrorsExplainStatus(t *testing.T) {
	for _, test := range []struct {
		status int
		want   string
	}{
		{404, "会话可能已删除，或当前账号无法访问"},
		{401, "请确认已登录"},
		{403, "无权访问"},
		{429, "请求过于频繁"},
		{503, "请稍后重新同步"},
		{0, "连接中断或读取超时"},
	} {
		message := desktopConversationReadError(test.status).Error()
		if !strings.Contains(message, test.want) || !strings.Contains(message, "本地已保存的对话和附件仍保留") || strings.Contains(message, "所属账号") {
			t.Fatalf("misleading status %d: %s", test.status, message)
		}
		if test.status != 404 && strings.Contains(message, "已删除") {
			t.Fatalf("unrelated failure described as deletion: %s", message)
		}
	}
}

func TestSessionSyncNotFoundPreservesArchiveAndAllowsRetry(t *testing.T) {
	s := testStore(t)
	i := newImporter(s)
	check(t, i.setDesktopCapture(true))
	job := desktopCaptureJob{ID: "deleted-remotely", updated: 110}
	check(t, i.importDesktopCapture(job, liveTestResult(job.ID, true, "", generatedImageMessage("image", 109)), false))
	check(t, i.importDesktopImages(job, desktopCaptureResult{ID: job.ID, Images: []desktopImage{{"sediment://image", imageFixture}}}))
	before, err := one(s.DB, "SELECT * FROM sessions WHERE id=?", "chatgpt:"+job.ID)
	check(t, err)
	messages, err := query(s.DB, "SELECT * FROM messages WHERE session_id=?", "chatgpt:"+job.ID)
	check(t, err)
	i.desktopRead = func(_ context.Context, jobs []desktopCaptureJob, accept func(desktopCaptureResult) error) error {
		return accept(desktopCaptureResult{Kind: "error", ID: jobs[0].ID, Status: 404})
	}
	started, err := i.startSessionSync("chatgpt:" + job.ID)
	check(t, err)
	if !started {
		t.Fatal("session sync did not start")
	}
	report := waitSessionSync(t, i)
	if len(report.Errors) != 1 || !strings.Contains(report.Errors[0].Error, "会话可能已删除") || report.SessionResult != nil || report.DesktopError != "" {
		t.Fatal("404 misreported as a successful read or broken Desktop connection", report)
	}
	after, err := one(s.DB, "SELECT * FROM sessions WHERE id=?", "chatgpt:"+job.ID)
	check(t, err)
	afterMessages, err := query(s.DB, "SELECT * FROM messages WHERE session_id=?", "chatgpt:"+job.ID)
	check(t, err)
	if jsonText(before) != jsonText(after) || jsonText(messages) != jsonText(afterMessages) || count(t, s, "assets") != 1 || count(t, s, "deleted_sessions") != 0 {
		t.Fatal("remote 404 altered or deleted the local archive")
	}
	row, err := one(s.DB, "SELECT value FROM settings WHERE key=?", desktopCheckpointPrefix+"chatgpt:"+job.ID)
	check(t, err)
	var checkpoint desktopCheckpoint
	check(t, json.Unmarshal([]byte(str(row["value"])), &checkpoint))
	if checkpoint.RetryAfter <= checkpoint.Attempt {
		t.Fatal("failed read lost its automatic retry backoff")
	}
	// Manual reads remain available if the conversation becomes accessible again.
	i.desktopRead = func(_ context.Context, jobs []desktopCaptureJob, accept func(desktopCaptureResult) error) error {
		return accept(liveTestResult(jobs[0].ID, true, "", cacheMessage("a", "assistant", "恢复访问后的回答", 110)))
	}
	started, err = i.startSessionSync("chatgpt:" + job.ID)
	check(t, err)
	if !started {
		t.Fatal("manual retry blocked after 404")
	}
	report = waitSessionSync(t, i)
	if len(report.Errors) != 0 || report.SessionResult == nil {
		t.Fatal("successful retry retained a stale 404 error", report)
	}
}

func TestDesktopNotFoundDoesNotStopOtherConversations(t *testing.T) {
	i := newImporter(testStore(t))
	jobs := []desktopCaptureJob{{ID: "missing", title: "已删除的会话"}, {ID: "available", title: "仍存在的会话"}}
	i.desktopRead = func(_ context.Context, _ []desktopCaptureJob, accept func(desktopCaptureResult) error) error {
		if err := accept(desktopCaptureResult{Kind: "error", ID: "missing", Status: 404}); err != nil {
			return err
		}
		return accept(liveTestResult("available", true, "", cacheMessage("a", "assistant", "正常同步的回答", 110)))
	}
	i.captureDesktopJobs(jobs, false, false)
	report := i.status()
	if len(report.Errors) != 0 || len(report.Warnings) != 1 || !strings.Contains(report.Warnings[0].Error, "会话可能已删除") || report.DesktopCaptured != 1 || count(t, i.Store, "messages") != 1 {
		t.Fatal("missing conversation interrupted the remaining batch", report)
	}
}
