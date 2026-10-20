package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
)

type mergeReport struct {
	SessionsAdded     int `json:"sessions_added"`
	SessionsMatched   int `json:"sessions_matched"`
	MessagesAdded     int `json:"messages_added"`
	MessagesDuplicate int `json:"messages_duplicate"`
	Conflicts         int `json:"conflicts"`
	SkippedDeleted    int `json:"skipped_deleted"`
}

// The caller supplies a private, validated snapshot, never a live source database.
// One transaction includes records, attachments, raw versions and rebuilt indexes.
// Source settings and sync cursors belong to the other device and are not imported.
func (s *Store) mergeArchive(ctx context.Context, path string) (mergeReport, error) {
	var report mergeReport
	uri := (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String() + "?mode=ro&immutable=1"
	source, err := sql.Open("sqlite", uri)
	if err != nil {
		return report, err
	}
	defer source.Close()
	s.importMu.Lock()
	defer s.importMu.Unlock()
	tx, err := s.Write.BeginTx(ctx, nil)
	if err != nil {
		return report, err
	}
	defer tx.Rollback()
	projects := map[string]bool{}
	if err = eachArchiveRow(ctx, tx, "SELECT DISTINCT project FROM sessions", func(row M) error {
		projects[str(row["project"])] = true
		return nil
	}); err != nil {
		return report, err
	}
	accepted := map[string]bool{}
	newSessions := map[string]bool{}
	deleted := map[string]bool{}
	const fields = "id,title,project,cwd,platform,provider,model,created,updated,archived,favorite,parent_id,metadata"
	err = eachArchiveRow(ctx, source, "SELECT "+fields+" FROM sessions ORDER BY id", func(row M) error {
		sid := str(row["id"])
		allowed, err := importSession(tx, sid, false)
		if err != nil {
			return err
		}
		if !allowed {
			report.SkippedDeleted++
			deleted[sid] = true
			return nil
		}
		accepted[sid] = true
		current, err := one(tx, "SELECT provider,metadata FROM sessions WHERE id=?", sid)
		if errors.Is(err, errNotFound) {
			args := []any{}
			for _, field := range strings.Split(fields, ",") {
				args = append(args, row[field])
			}
			_, err = tx.Exec("INSERT INTO sessions("+fields+") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", args...)
			if err == nil {
				report.SessionsAdded++
				newSessions[sid] = true
			}
			return err
		}
		if err != nil {
			return err
		}
		if str(current["provider"]) != str(row["provider"]) {
			return fmt.Errorf("对话 ID %s 的来源类型冲突，合并已取消", sid)
		}
		metadata, err := mergeMetadata(str(current["metadata"]), str(row["metadata"]))
		if err != nil {
			return err
		}
		// Keep local titles, project assignments and visibility. Favorites are a union.
		_, err = tx.Exec("UPDATE sessions SET favorite=max(favorite,?),created=min(created,?),updated=max(updated,?),metadata=? WHERE id=?", row["favorite"], row["created"], row["updated"], metadata, sid)
		report.SessionsMatched++
		return err
	})
	if err != nil {
		return report, err
	}
	// IDs are content addressed; conflicting payloads must not silently win.
	err = eachArchiveRow(ctx, source, "SELECT id,mime,payload FROM assets", func(row M) error {
		payload, err := archiveBytes(row["payload"])
		if err != nil {
			return err
		}
		current, err := one(tx, "SELECT payload FROM assets WHERE id=?", row["id"])
		if errors.Is(err, errNotFound) {
			_, err = tx.Exec("INSERT INTO assets VALUES (?,?,?)", row["id"], row["mime"], row["payload"])
			return err
		}
		if err == nil {
			local, e := archiveBytes(current["payload"])
			if e != nil {
				return e
			}
			if !bytes.Equal(local, payload) {
				return fmt.Errorf("附件 ID %s 的内容冲突，合并已取消", row["id"])
			}
		}
		return err
	})
	if err != nil {
		return report, err
	}
	err = eachArchiveRow(ctx, source, "SELECT * FROM messages ORDER BY session_id,position,id", func(row M) error {
		sid := str(row["session_id"])
		if !accepted[sid] {
			if deleted[sid] {
				return nil
			}
			return fmt.Errorf("备份消息缺少所属对话 %s", sid)
		}
		payload, err := archiveBytes(row["body"])
		if err != nil {
			return err
		}
		body, err := unpack(payload)
		if err != nil {
			return fmt.Errorf("对话 %s 的正文损坏: %w", sid, err)
		}
		var metadata M
		if err = json.Unmarshal([]byte(str(row["metadata"])), &metadata); err != nil {
			return err
		}
		current, err := one(tx, "SELECT body,metadata,role,kind,phase FROM messages WHERE session_id=? AND identity=?", sid, row["identity"])
		if errors.Is(err, errNotFound) {
			added, err := s.message(tx, sid, str(row["identity"]), integer(row["position"]), str(row["role"]), body, number(row["timestamp"]), str(row["kind"]), str(row["phase"]), metadata)
			if added {
				report.MessagesAdded++
			} else if err == nil {
				return errors.New("备份含有无法导入的空消息，合并已取消")
			}
			return err
		}
		if err != nil {
			return err
		}
		localBody, err := unpack(current["body"].([]byte))
		if err != nil {
			return err
		}
		if body != localBody || str(row["role"]) != str(current["role"]) || str(row["kind"]) != str(current["kind"]) || str(row["phase"]) != str(current["phase"]) || str(row["metadata"]) != str(current["metadata"]) {
			// Preserve the incoming version without duplicating the message in the reader.
			version := M{"type": "archive_merge_version", "session_id": sid, "message": row}
			row["body"] = body
			raw := []byte(jsonText(version))
			if err = s.addRaw(tx, "archive-merge://message/"+hash(raw), sid, 0, 0, int64(len(raw)), raw); err != nil {
				return err
			}
			if body != localBody || str(row["role"]) != str(current["role"]) || str(row["kind"]) != str(current["kind"]) || str(row["phase"]) != str(current["phase"]) {
				report.Conflicts++
			} else {
				report.MessagesDuplicate++
			}
		} else {
			report.MessagesDuplicate++
		}
		merged, err := mergeMetadata(str(current["metadata"]), str(row["metadata"]))
		if err != nil {
			return err
		}
		_, err = tx.Exec("UPDATE messages SET metadata=? WHERE session_id=? AND identity=?", merged, sid, row["identity"])
		return err
	})
	if err != nil {
		return report, err
	}
	err = eachArchiveRow(ctx, source, "SELECT * FROM raw_chunks ORDER BY id", func(row M) error {
		sid := str(row["session_id"])
		if sid != "" && !accepted[sid] {
			if deleted[sid] {
				return nil
			}
			return fmt.Errorf("备份原始记录缺少所属对话 %s", sid)
		}
		payload, err := archiveBytes(row["payload"])
		if err != nil {
			return err
		}
		raw, err := archiveRaw(source, payload)
		if err != nil {
			return err
		}
		path := str(row["path"])
		current, err := one(tx, "SELECT session_id,payload FROM raw_chunks WHERE path=? AND generation=? AND start=? AND end=?", path, row["generation"], row["start"], row["end"])
		if err == nil {
			local, e := archiveRaw(tx, current["payload"].([]byte))
			if e != nil {
				return e
			}
			if local == raw && str(current["session_id"]) == sid {
				return nil
			}
		} else if !errors.Is(err, errNotFound) {
			return err
		}
		// A later local sync starts without the other device's file cursor. Imported
		// chunks must never occupy real file coordinates and mask that sync's events.
		// Preserve our namespace when merging a backup of a previously merged archive.
		if !strings.HasPrefix(path, "archive-merge://") {
			path = "archive-merge://raw/" + hash([]byte(path+"\x00"+sid))
		}
		current, err = one(tx, "SELECT session_id,payload FROM raw_chunks WHERE path=? AND generation=? AND start=? AND end=?", path, row["generation"], row["start"], row["end"])
		if err == nil {
			local, e := archiveRaw(tx, current["payload"].([]byte))
			if e != nil {
				return e
			}
			if local == raw && str(current["session_id"]) == sid {
				return nil
			}
			// The same file coordinates can hold different versions on two devices.
			path = "archive-merge://raw/" + hash([]byte(path+"\x00"+sid+"\x00"+raw))
		} else if !errors.Is(err, errNotFound) {
			return err
		}
		return s.addRaw(tx, path, sid, integer(row["generation"]), integer(row["start"]), integer(row["end"]), []byte(raw))
	})
	if err != nil {
		return report, err
	}
	// Older archives may not contain the optional visibility tables.
	for _, table := range []string{"hidden_projects", "session_visibility"} {
		var exists bool
		if err = source.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)", table).Scan(&exists); err != nil {
			return report, err
		}
		if !exists {
			continue
		}
		err = eachArchiveRow(ctx, source, "SELECT * FROM "+table, func(row M) error {
			if table == "hidden_projects" {
				if projects[str(row["project"])] {
					return nil
				}
				_, err := tx.Exec("INSERT OR IGNORE INTO hidden_projects(project) SELECT ? WHERE EXISTS(SELECT 1 FROM sessions WHERE project=?)", row["project"], row["project"])
				return err
			}
			if !newSessions[str(row["session_id"])] {
				return nil
			}
			// Existing effective visibility, including explicit show, takes priority.
			_, err := tx.Exec("INSERT OR IGNORE INTO session_visibility(session_id,hidden) VALUES (?,?)", row["session_id"], row["hidden"])
			return err
		})
		if err != nil {
			return report, err
		}
	}
	for sid := range accepted {
		if err = s.recount(tx, sid); err != nil {
			return report, err
		}
	}
	return report, tx.Commit()
}

// Stream rows so even large archives never load all messages or images into memory.
func eachArchiveRow(ctx context.Context, db interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, query string, visit func(M) error) error {
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return err
	}
	for rows.Next() {
		if err = ctx.Err(); err != nil {
			return err
		}
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err = rows.Scan(pointers...); err != nil {
			return err
		}
		row := M{}
		for i, column := range columns {
			row[column] = values[i]
		}
		if err = visit(row); err != nil {
			return err
		}
	}
	return rows.Err()
}

func archiveRaw(db DBQuery, payload []byte) (string, error) {
	if bytes.HasPrefix(payload, []byte(rawReference)) {
		row, err := one(db, "SELECT payload FROM raw_blobs WHERE digest=?", string(payload[len(rawReference):]))
		if err != nil {
			return "", err
		}
		payload, err = archiveBytes(row["payload"])
		if err != nil {
			return "", err
		}
	}
	return unpack(payload)
}

func archiveBytes(value any) ([]byte, error) {
	if payload, ok := value.([]byte); ok {
		return payload, nil
	}
	return nil, errors.New("档案中的正文或附件格式无效，合并已取消")
}

// Keep local values, fill missing fields, and collect attachment IDs from both sides.
func mergeMetadata(local, incoming string) (string, error) {
	var a, b M
	if err := json.Unmarshal([]byte(local), &a); err != nil {
		return "", err
	}
	if err := json.Unmarshal([]byte(incoming), &b); err != nil {
		return "", err
	}
	if a == nil {
		a = M{}
	}
	for key, value := range b {
		if key == "assets" {
			items := append([]any{}, array(a[key])...)
			seen := map[string]bool{}
			for _, item := range items {
				seen[jsonText(item)] = true
			}
			for _, item := range array(value) {
				if !seen[jsonText(item)] {
					items = append(items, item)
					seen[jsonText(item)] = true
				}
			}
			a[key] = items
		} else if _, exists := a[key]; !exists {
			a[key] = value
		}
	}
	return jsonText(a), nil
}
