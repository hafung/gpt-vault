package main

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

var codexImageOpen = regexp.MustCompile(`^<image name=\[Image #[0-9]+\] path="[^"\r\n]+">$`)
var codexImagePrefix = regexp.MustCompile(`^(?:<image name=\[Image #[0-9]+\] path="[^"\r\n]+">\r?\n</image>\r?\n)+`)

// Only discard transport wrappers when they surround a real image part.
// Literal examples in the user's text continue to be preserved.
func codexResponseText(content any) string {
	parts := array(content)
	if parts == nil {
		return textContent(content)
	}
	kept := []any{}
	for n := 0; n < len(parts); n++ {
		if n+2 < len(parts) && codexImageOpen.MatchString(textContent(parts[n])) && strings.EqualFold(str(obj(parts[n+1])["type"]), "input_image") && textContent(parts[n+2]) == "</image>" {
			n += 2
			continue
		}
		kept = append(kept, parts[n])
	}
	return textContent(kept)
}

// Match only nearby records from the two Codex representations. Equal text
// from distinct canonical items (including repeated questions) stays separate.
func (s *Store) reconcileCodexMirrors(db DBQuery, sid string, pos int64) error {
	responses, err := query(db, `SELECT * FROM messages WHERE session_id=? AND identity LIKE 'response:%' AND role IN ('user','assistant') AND position BETWEEN ? AND ?`, sid, pos-2, pos+2)
	if err != nil {
		return err
	}
	for _, response := range responses {
		body, err := unpack(response["body"].([]byte))
		if err != nil {
			return err
		}
		var rm M
		if err = json.Unmarshal([]byte(str(response["metadata"])), &rm); err != nil {
			return err
		}
		if response["role"] == "user" && len(array(rm["assets"])) > 0 {
			body = codexImagePrefix.ReplaceAllString(body, "")
		}
		items, err := query(db, `SELECT * FROM messages WHERE session_id=? AND role=? AND identity LIKE 'item:%' AND position BETWEEN ? AND ? ORDER BY abs(position-?),id`, sid, response["role"], integer(response["position"])-2, integer(response["position"])+2, response["position"])
		if err != nil {
			return err
		}
		for _, item := range items {
			canonical, err := unpack(item["body"].([]byte))
			if err != nil {
				return err
			}
			if strings.TrimSpace(canonical) != strings.TrimSpace(body) {
				continue
			}
			var meta M
			if err = json.Unmarshal([]byte(str(item["metadata"])), &meta); err != nil {
				return err
			}
			meta["assets"] = mergeCodexAssets(array(meta["assets"]), array(rm["assets"]))
			if _, err = s.message(db, sid, str(item["identity"]), integer(item["position"]), str(item["role"]), canonical, number(item["timestamp"]), str(item["kind"]), str(item["phase"]), meta); err != nil {
				return err
			}
			for _, table := range []string{"search_long", "search_short", "dialogue_long", "dialogue_short", "messages"} {
				key := "rowid"
				if table == "messages" {
					key = "id"
				}
				if _, err = db.Exec("DELETE FROM "+table+" WHERE "+key+"=?", response["id"]); err != nil {
					return err
				}
			}
			break
		}
	}
	return nil
}

// Existing archives must be repaired even when source watermarks have not
// changed. Original raw records and image bytes remain available for export.
func (s *Store) recoverCodexMessages() error {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	const key = "codex_messages_version"
	if row, err := one(s.DB, "SELECT value FROM settings WHERE key=?", key); err == nil && row["value"] == "1" {
		return nil
	} else if err != nil && !errors.Is(err, errNotFound) {
		return err
	}
	tx, err := s.Write.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := query(tx, `SELECT m.* FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.provider='Codex' AND m.identity LIKE 'item:%' AND m.role='tool' AND m.kind IN ('UserMessage','AgentMessage')`)
	if err != nil {
		return err
	}
	touched := map[string]bool{}
	importer := newImporter(s)
	for _, row := range rows {
		body, err := unpack(row["body"].([]byte))
		if err != nil {
			return err
		}
		var item M
		if json.Unmarshal([]byte(body), &item) != nil {
			continue
		}
		sid := str(row["session_id"])
		if _, err = importer.item(tx, sid, item, integer(row["position"]), number(row["timestamp"]), str(row["identity"])); err != nil {
			return err
		}
		touched[sid] = true
	}
	rows, err = query(tx, `SELECT m.* FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.provider='Codex' AND m.identity LIKE 'response:%' AND m.role IN ('user','assistant') AND (EXISTS (SELECT 1 FROM messages c WHERE c.session_id=m.session_id AND c.identity LIKE 'item:%' AND c.position BETWEEN m.position-2 AND m.position+2) OR (m.role='user' AND json_array_length(m.metadata,'$.assets')>0))`)
	if err != nil {
		return err
	}
	for _, row := range rows {
		sid := str(row["session_id"])
		if row["role"] == "user" {
			body, err := unpack(row["body"].([]byte))
			if err != nil {
				return err
			}
			var meta M
			if err = json.Unmarshal([]byte(str(row["metadata"])), &meta); err != nil {
				return err
			}
			if len(array(meta["assets"])) > 0 {
				clean := codexImagePrefix.ReplaceAllString(body, "")
				if clean != body {
					if _, err = s.message(tx, sid, str(row["identity"]), integer(row["position"]), "user", clean, number(row["timestamp"]), str(row["kind"]), str(row["phase"]), meta); err != nil {
						return err
					}
				}
			}
		}
		if err = s.reconcileCodexMirrors(tx, sid, integer(row["position"])); err != nil {
			return err
		}
		touched[sid] = true
	}
	for sid := range touched {
		if err = s.recount(tx, sid); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("INSERT OR REPLACE INTO settings(key,value) VALUES (?, '1')", key); err != nil {
		return err
	}
	return tx.Commit()
}

func mergeCodexAssets(assets, incoming []any) []any {
	for _, asset := range incoming {
		found := false
		for _, previous := range assets {
			if jsonText(previous) == jsonText(asset) {
				found = true
				break
			}
		}
		if !found {
			assets = append(assets, asset)
		}
	}
	return assets
}
