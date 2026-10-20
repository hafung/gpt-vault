package main

import (
	"bytes"
	"context"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mergeSnapshot(t *testing.T, s *Store) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "backup.sqlite")
	check(t, s.backupTo(context.Background(), path, nil))
	return path
}

func mergeMessage(t *testing.T, s *Store, sid, identity, body string, metadata M) {
	t.Helper()
	_, err := s.message(s.Write, sid, identity, 0, "user", body, 100, "message", "", metadata)
	check(t, err)
	check(t, s.recount(s.Write, sid))
}

func TestMergeUnionsArchivesAndIsIdempotent(t *testing.T) {
	local, source := testStore(t), testStore(t)
	for _, sid := range []string{"A", "B"} {
		check(t, local.session(local.Write, sid, M{"title": "本机" + sid, "project": "echo-vault", "cwd": "D:/projects/echo-vault"}))
		mergeMessage(t, local, sid, "same-message-id", "当前正文"+sid, M{})
	}
	for _, sid := range []string{"B", "C"} {
		check(t, source.session(source.Write, sid, M{"title": "备份" + sid, "project": "echo-vault", "cwd": "/home/old/projects/echo-vault"}))
		mergeMessage(t, source, sid, "same-message-id", "当前正文"+sid, M{"assets": []any{"image"}})
	}
	mergeMessage(t, source, "B", "new-message", "合并新增独有正文", M{})
	_, err := local.Write.Exec(`INSERT INTO settings VALUES ('sources','["local-path"]'); INSERT INTO settings VALUES ('backup_directory','local-backups'); INSERT INTO files(path,session_id,offset) VALUES ('local-log','B',123); INSERT INTO session_visibility VALUES ('B',0); INSERT INTO hidden_projects VALUES ('local-hidden')`)
	check(t, err)
	_, err = source.Write.Exec(`INSERT INTO settings VALUES ('sources','["foreign-path"]'); INSERT INTO settings VALUES ('backup_directory','foreign-backups'); INSERT INTO files(path,session_id,offset) VALUES ('foreign-log','B',999); INSERT INTO assets VALUES ('image','image/png',X'010203'); UPDATE sessions SET favorite=1; INSERT INTO session_visibility VALUES ('B',1),('C',1); INSERT INTO hidden_projects VALUES ('echo-vault'); INSERT INTO deleted_sessions VALUES ('A',1)`)
	check(t, err)
	check(t, local.addRaw(local.Write, "same-source-path", "B", 0, 0, 100, []byte("本机原始版本")))
	check(t, source.addRaw(source.Write, "same-source-path", "B", 0, 0, 100, []byte("备份原始版本")))
	path := mergeSnapshot(t, source)
	before := fileHash(t, path)
	report, err := local.mergeArchive(context.Background(), path)
	check(t, err)
	if report.SessionsAdded != 1 || report.SessionsMatched != 1 || report.MessagesAdded != 2 || report.MessagesDuplicate != 1 || report.Conflicts != 0 {
		t.Fatalf("合并计数不正确: %+v", report)
	}
	for q, want := range map[string]int{
		"SELECT count(*) FROM sessions":                                         3,
		"SELECT count(DISTINCT project) FROM sessions":                          1,
		"SELECT count(*) FROM messages":                                         4,
		"SELECT count(*) FROM assets":                                           1,
		"SELECT favorite FROM sessions WHERE id='B'":                            1,
		"SELECT hidden FROM session_visibility WHERE session_id='B'":            0,
		"SELECT hidden FROM session_visibility WHERE session_id='C'":            1,
		"SELECT count(*) FROM hidden_projects WHERE project='echo-vault'":       0,
		"SELECT count(*) FROM deleted_sessions":                                 0,
		"SELECT count(*) FROM files":                                            1,
		`SELECT count(*) FROM dialogue_long WHERE dialogue_long MATCH '"新增独有"'`: 1,
		`SELECT count(*) FROM search_long WHERE search_long MATCH '"新增独有"'`:     1,
	} {
		var got int
		check(t, local.DB.QueryRow(q).Scan(&got))
		if got != want {
			t.Fatalf("%s = %d, want %d", q, got, want)
		}
	}
	row, err := one(local.DB, "SELECT title,cwd FROM sessions WHERE id='B'")
	check(t, err)
	if row["title"] != "本机B" || row["cwd"] != "D:/projects/echo-vault" {
		t.Fatal("本机项目或标题被替换", row)
	}
	for key, want := range map[string]string{"sources": `["local-path"]`, "backup_directory": "local-backups"} {
		row, err := one(local.DB, "SELECT value FROM settings WHERE key=?", key)
		check(t, err)
		if row["value"] != want {
			t.Fatal("本机配置被替换", key)
		}
	}
	var raw bytes.Buffer
	check(t, local.export("B", "raw", &raw))
	if !strings.Contains(raw.String(), "本机原始版本") || !strings.Contains(raw.String(), "备份原始版本") {
		t.Fatal("路径相同的原始版本丢失", raw.String())
	}
	counts := map[string]int{}
	for _, table := range []string{"sessions", "messages", "raw_chunks", "raw_blobs", "assets"} {
		counts[table] = count(t, local, table)
	}
	second, err := local.mergeArchive(context.Background(), path)
	check(t, err)
	if second.SessionsAdded != 0 || second.MessagesAdded != 0 {
		t.Fatal("重复合并增加了对话或消息", second)
	}
	for table, want := range counts {
		if got := count(t, local, table); got != want {
			t.Fatalf("重复合并增加 %s: %d -> %d", table, want, got)
		}
	}
	if !bytes.Equal(before, fileHash(t, path)) {
		t.Fatal("合并改动了备份")
	}
	stats, err := local.stats(context.Background(), true)
	check(t, err)
	if len(stats["projects_list"].([]M)) != 1 {
		t.Fatal("左侧项目没有归到同一项", stats)
	}
}

func TestMergeKeepsConflictingBodyAndDeletedChoices(t *testing.T) {
	local, source := testStore(t), testStore(t)
	for _, s := range []*Store{local, source} {
		check(t, s.session(s.Write, "B", M{"title": "B", "project": "shared"}))
	}
	mergeMessage(t, local, "B", "m", "当前较新正文", M{"assets": []any{"local"}})
	mergeMessage(t, source, "B", "m", "备份不同正文", M{"assets": []any{"remote"}})
	_, err := local.Write.Exec("INSERT INTO assets VALUES ('local','image/png',X'01'); INSERT INTO deleted_sessions VALUES ('deleted',1)")
	check(t, err)
	_, err = source.Write.Exec("INSERT INTO assets VALUES ('remote','image/png',X'02'); INSERT INTO session_visibility VALUES ('B',1)")
	check(t, err)
	check(t, source.session(source.Write, "deleted", M{"title": "不应复活"}))
	mergeMessage(t, source, "deleted", "d", "已删除记录", M{})
	check(t, source.addRaw(source.Write, "deleted-source", "deleted", 0, 0, 10, []byte("已删除原始记录")))
	path := mergeSnapshot(t, source)
	for i := 0; i < 2; i++ {
		report, err := local.mergeArchive(context.Background(), path)
		check(t, err)
		if report.Conflicts != 1 || report.SkippedDeleted != 1 || count(t, local, "messages") != 1 || count(t, local, "sessions") != 1 || count(t, local, "raw_chunks") != 1 {
			t.Fatal("冲突合并或重复导入失败", report)
		}
	}
	page, err := local.messages(context.Background(), "B", url.Values{})
	check(t, err)
	items := page["items"].([]M)
	if items[0]["body"] != "当前较新正文" || len(array(obj(items[0]["metadata"])["assets"])) != 2 {
		t.Fatal("冲突正文或附件丢失", items)
	}
	var raw bytes.Buffer
	check(t, local.export("B", "raw", &raw))
	if !strings.Contains(raw.String(), "备份不同正文") || !strings.Contains(raw.String(), "archive_merge_version") {
		t.Fatal("备份冲突版本没有保留", raw.String())
	}
	if count(t, local, "session_visibility") != 0 {
		t.Fatal("备份覆盖了当前隐含的可见状态")
	}
}

func TestMergeRollsBackOnCorruptMessageOrAssetCollision(t *testing.T) {
	for _, failure := range []string{"message", "asset", "raw"} {
		t.Run(failure, func(t *testing.T) {
			local, source := testStore(t), testStore(t)
			check(t, local.session(local.Write, "keep", M{"title": "keep"}))
			mergeMessage(t, local, "keep", "m", "原有正文", M{})
			check(t, source.session(source.Write, "new", M{"title": "new"}))
			mergeMessage(t, source, "new", "m", "新正文", M{})
			_, err := local.Write.Exec("INSERT INTO assets VALUES ('collision','image/png',X'01')")
			check(t, err)
			_, err = source.Write.Exec("INSERT INTO assets VALUES ('new-asset','image/png',X'02')")
			check(t, err)
			switch failure {
			case "message":
				_, err = source.Write.Exec("UPDATE messages SET body='invalid-blob'")
			case "asset":
				_, err = source.Write.Exec("INSERT INTO assets VALUES ('collision','image/png',X'03')")
			case "raw":
				_, err = source.Write.Exec("INSERT INTO raw_chunks(path,session_id,generation,start,end,payload) VALUES ('broken','new',0,0,1,?)", []byte(rawReference+"missing"))
			}
			check(t, err)
			_, err = local.mergeArchive(context.Background(), mergeSnapshot(t, source))
			if err == nil {
				t.Fatal("合并损坏的记录没有失败")
			}
			for table, want := range map[string]int{"sessions": 1, "messages": 1, "assets": 1, "raw_chunks": 0} {
				if count(t, local, table) != want {
					t.Fatal("失败后存在部分写入", table)
				}
			}
			var n int
			check(t, local.DB.QueryRow(`SELECT count(*) FROM dialogue_long WHERE dialogue_long MATCH '"新正文"'`).Scan(&n))
			if n != 0 {
				t.Fatal("失败后遗留搜索索引")
			}
		})
	}
}

func TestMergeAPIPathsAndCompressedUploads(t *testing.T) {
	local, source := testStore(t), testStore(t)
	check(t, source.session(source.Write, "new", M{"title": "new", "project": "shared"}))
	mergeMessage(t, source, "new", "m", "上传备份正文", M{})
	app := &App{Store: local}
	t.Cleanup(app.restores.close)
	path := mergeSnapshot(t, source)
	res := backupRequest(t, app, "POST", "/api/restore", jsonText(M{"path": path, "mode": "merge"}))
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	job := awaitRestore(t, app)
	if job.Stage != "ready" || job.Mode != "merge" || job.Command != "" || job.Path != "" || job.Merge == nil || job.Merge.SessionsAdded != 1 {
		t.Fatal("合并返回错误结果", job)
	}
	compressed := path + ".zst"
	check(t, os.WriteFile(compressed, nil, 0600))
	check(t, compressSnapshot(context.Background(), path, compressed, "zstd", nil))
	data, err := os.ReadFile(compressed)
	check(t, err)
	req := httptest.NewRequest("POST", "http://localhost/api/restore/upload?mode=merge", bytes.NewReader(data))
	req.Header.Set("X-Echo-Request", "1")
	res = httptest.NewRecorder()
	app.ServeHTTP(res, req)
	if res.Code != 200 {
		t.Fatal(res.Body.String())
	}
	job = awaitRestore(t, app)
	if job.Stage != "ready" || job.Merge == nil || job.Merge.MessagesAdded != 0 || job.Merge.MessagesDuplicate != 1 || count(t, local, "messages") != 1 {
		t.Fatal("上传压缩备份未正确去重", job)
	}
	// Shutdown waits for the private staging snapshot to be removed.
	app.restores.close()
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(local.Path), "restored"))
	check(t, err)
	if len(entries) != 0 {
		t.Fatal("合并后残留独立档案或上传文件", entries)
	}
	res = backupRequest(t, app, "POST", "/api/restore", jsonText(M{"path": path, "mode": "overwrite"}))
	if res.Code == 200 {
		t.Fatal("接受了无效导入方式")
	}
}

func TestMergeRawChunksDoNotMaskLaterLocalSync(t *testing.T) {
	local, source := testStore(t), testStore(t)
	check(t, source.session(source.Write, "s", M{"title": "s"}))
	check(t, source.addRaw(source.Write, "/same/log.jsonl", "s", 0, 0, 100, []byte("备份原始版本")))
	path := mergeSnapshot(t, source)
	_, err := local.mergeArchive(context.Background(), path)
	check(t, err)
	// File cursors are intentionally local. A new device's first sync can reuse
	// generation zero and exactly the same byte offsets for different content.
	check(t, local.addRaw(local.Write, "/same/log.jsonl", "s", 0, 0, 100, []byte("本机首次同步版本")))
	var raw bytes.Buffer
	check(t, local.export("s", "raw", &raw))
	if !strings.Contains(raw.String(), "备份原始版本") || !strings.Contains(raw.String(), "本机首次同步版本") {
		t.Fatal("合并占用了本机日志位置，导致后续同步版本丢失", raw.String())
	}
	_, err = local.mergeArchive(context.Background(), path)
	check(t, err)
	if count(t, local, "raw_chunks") != 2 {
		t.Fatal("重复合并产生额外原始版本")
	}
	// Backing up and reimporting an already merged archive must keep the same
	// namespace, rather than prefixing paths again and duplicating every chunk.
	merged := mergeSnapshot(t, local)
	_, err = local.mergeArchive(context.Background(), merged)
	check(t, err)
	if count(t, local, "raw_chunks") != 2 {
		t.Fatal("再次导入已合并档案产生额外原始版本")
	}
}
