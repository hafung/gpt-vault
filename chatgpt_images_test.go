package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const imageFixture = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII="

func imageConversation() desktopCaptureResult {
	q := cacheMessage("q", "user", "图片问题", 100)
	q["content"] = M{"content_type": "multimodal_text", "parts": []any{M{"asset_pointer": "sediment://file_test"}, "图片问题"}}
	a := cacheMessage("a", "assistant", "\ue200image_group\ue202{\"image_refs\":[\"turn1image0\"]}\ue201", 101)
	a["metadata"] = M{"content_references": []any{M{"type": "image_group", "images": []any{M{"image_result": M{"content_url": "https://images.example/full.png", "thumbnail_url": "https://images.example/thumb.png"}}}}}}
	return liveTestResult("images", true, "", q, a)
}

func TestDesktopImagesDeduplicateSurviveReimportBackupAndDeletion(t *testing.T) {
	s := testStore(t)
	i := newImporter(s)
	job := desktopCaptureJob{ID: "images"}
	check(t, i.importDesktopCapture(job, imageConversation(), false))
	result := desktopCaptureResult{ID: job.ID, Images: []desktopImage{{"sediment://file_test", imageFixture}, {"https://images.example/full.png", imageFixture}}}
	check(t, i.importDesktopImages(job, result))
	check(t, i.importDesktopImages(job, result))
	check(t, i.importDesktopCapture(job, imageConversation(), false))
	if count(t, s, "assets") != 1 {
		t.Fatal("identical bytes were not deduplicated")
	}
	prepared, err := i.desktopImageJob(job)
	check(t, err)
	if len(prepared.KnownImages) != 2 {
		t.Fatal("a reimport discarded archived image references")
	}
	// A later message can reuse an already downloaded file without fetching it.
	newMessage := cacheMessage("reused", "user", "再次使用", 102)
	newMessage["content"] = M{"parts": []any{M{"asset_pointer": "sediment://file_test"}, "再次使用"}}
	check(t, i.importDesktopCapture(job, liveTestResult(job.ID, true, "", newMessage), false))
	check(t, i.importDesktopImages(prepared, desktopCaptureResult{ID: job.ID}))
	reused, err := one(s.DB, "SELECT metadata FROM messages WHERE identity='node:reused'")
	check(t, err)
	var reusedMetadata M
	check(t, json.Unmarshal([]byte(str(reused["metadata"])), &reusedMetadata))
	if len(obj(reusedMetadata["image_assets"])) != 1 {
		t.Fatal("known image was not linked to a new message")
	}
	row, err := one(s.DB, "SELECT metadata FROM messages WHERE session_id='chatgpt:images' AND identity='node:q'")
	check(t, err)
	var metadata M
	check(t, json.Unmarshal([]byte(str(row["metadata"])), &metadata))
	if len(array(metadata["assets"])) != 1 || obj(array(metadata["assets"])[0])["reference"] != nil {
		t.Fatal("resolved attachment still rendered as a missing pointer", metadata)
	}
	app := &App{Store: s}
	t.Cleanup(app.backups.close)
	res := backupRequest(t, app, "POST", "/api/backup/settings", jsonText(M{"directory": t.TempDir()}))
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	res = backupRequest(t, app, "POST", "/api/backup", `{"mode":"local"}`)
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	backup := awaitBackup(t, app)
	if backup.Stage != "ready" {
		t.Fatal(backup)
	}
	path := filepath.Join(t.TempDir(), "restored.sqlite")
	err = restoreArchive(context.Background(), backup.Path, path, nil)
	check(t, err)
	restored, err := openStore(path)
	check(t, err)
	defer restored.Close()
	if count(t, restored, "assets") != 1 {
		t.Fatal("backup lost archived image")
	}
	raw, _ := base64.StdEncoding.DecodeString(imageFixture)
	res = backupRequest(t, &App{Store: restored}, "GET", "/api/assets/"+hash(raw), "")
	if res.Code != 200 || res.Body.String() != string(raw) {
		t.Fatal("restored image cannot be read offline")
	}
	check(t, s.deleteSession(context.Background(), "chatgpt:images"))
	check(t, i.importDesktopImages(job, result))
	if count(t, s, "assets") != 0 {
		t.Fatal("image download resurrected a deletion")
	}
}

// Optional live probe also covers archived conversations whose body endpoint is
// no longer available. Only the explicitly supplied file reference is requested.
func TestDesktopAttachmentReadProbe(t *testing.T) {
	id, ref := os.Getenv("ECHO_DESKTOP_ATTACHMENT_TEST_ID"), os.Getenv("ECHO_DESKTOP_ATTACHMENT_TEST_REF")
	if id == "" || ref == "" {
		t.Skip("set an explicit Desktop attachment probe")
	}
	if !desktopConversationID.MatchString(id) {
		t.Fatal("invalid probe ID")
	}
	i := newImporter(testStore(t))
	check(t, i.Store.session(i.Store.Write, "chatgpt:"+id, M{"title": "图片下载验证"}))
	_, err := i.Store.message(i.Store.Write, "chatgpt:"+id, "probe", 0, "user", "图片", now(), "message", "", M{"assets": []any{M{"reference": ref}}})
	check(t, err)
	job, err := i.desktopImageJob(desktopCaptureJob{ID: id})
	check(t, err)
	pending := 0
	check(t, readDesktopCapture(context.Background(), []desktopCaptureJob{job}, func(result desktopCaptureResult) error {
		switch result.Kind {
		case "conversation":
			return i.importDesktopCapture(job, result, false)
		case "error":
			t.Logf("body status=%d", result.Status)
			return nil
		case "images":
			pending = result.PendingImages
			return i.importDesktopImages(job, result)
		default:
			return &liveProbeError{result.Kind, result.Status}
		}
	}))
	t.Logf("attachment payloads=%d pending_images=%d", count(t, i.Store, "assets"), pending)
	if count(t, i.Store, "assets") == 0 {
		t.Fatal("attachment was unavailable to the current Desktop login")
	}
}

func TestDesktopImagesRejectNonImagesAtomicallyAndRetryMissingImages(t *testing.T) {
	s := testStore(t)
	i := newImporter(s)
	job := desktopCaptureJob{ID: "images"}
	check(t, i.importDesktopCapture(job, imageConversation(), false))
	jobs, err := i.desktopCaptureCandidates(false, now())
	check(t, err)
	if len(jobs) != 1 {
		t.Fatal("old completed text was not queued for image backfill")
	}
	err = i.importDesktopImages(job, desktopCaptureResult{ID: job.ID, Images: []desktopImage{{"sediment://file_test", imageFixture}, {"https://images.example/full.png", base64.StdEncoding.EncodeToString([]byte("<html>login page</html>"))}}})
	if err == nil || count(t, s, "assets") != 0 {
		t.Fatal("invalid image response was accepted or partially committed")
	}
	check(t, i.importDesktopImages(job, desktopCaptureResult{ID: job.ID, PendingImages: 2}))
	jobs, err = i.desktopCaptureCandidates(false, now())
	check(t, err)
	if len(jobs) != 0 {
		t.Fatal("unavailable images ignored retry delay")
	}
	jobs, err = i.desktopCaptureCandidates(false, now()+3601)
	check(t, err)
	if len(jobs) != 1 {
		t.Fatal("unavailable images were never retried")
	}
}

func TestImageMappingsMergeAndFreshUIAddressesSurvive(t *testing.T) {
	merged, err := mergeMetadata(jsonText(M{"image_assets": M{"first": "id-one"}, "assets": []any{M{"reference": "sediment://second"}}}), jsonText(M{"image_assets": M{"sediment://second": "id-two"}, "assets": []any{"id-two"}}))
	check(t, err)
	var metadata M
	check(t, json.Unmarshal([]byte(merged), &metadata))
	if len(obj(metadata["image_assets"])) != 2 || len(array(metadata["assets"])) != 1 || str(array(metadata["assets"])[0]) != "id-two" {
		t.Fatal("merge lost mappings or kept unresolved references", metadata)
	}
	s := testStore(t)
	i := newImporter(s)
	job := desktopCaptureJob{ID: "images"}
	check(t, i.importDesktopCapture(job, imageConversation(), false))
	fresh := imageConversation()
	message := obj(array(fresh.Conversation["messages"])[1])
	obj(message["metadata"])["content_references"] = []any{M{"type": "image_group", "images": []any{M{"image_result": M{"content_url": "https://images.example/new-address.png"}}}}}
	check(t, i.importDesktopCapture(job, fresh, false))
	prepared, err := i.desktopImageJob(job)
	check(t, err)
	found := false
	for _, source := range prepared.Images {
		found = found || source.Reference == "https://images.example/new-address.png"
	}
	if !found {
		t.Fatal("old UI snapshot replaced fresh image addresses")
	}
}
