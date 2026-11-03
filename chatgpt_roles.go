package main

import (
	"encoding/json"
	"errors"
)

// Desktop exposes generated images as tool messages, including answers that
// consist solely of an image. Keep their source role while presenting them as
// replies. Assistant messages addressed to a tool are calls, not reply text.
func chatGPTMessageRole(message M) string {
	role := str(obj(message["author"])["role"])
	metadata, content := obj(message["metadata"]), obj(message["content"])
	if metadata["is_visually_hidden_from_conversation"] == true {
		return "context"
	}
	if role == "assistant" {
		if content["content_type"] == "thoughts" || content["content_type"] == "reasoning_recap" {
			return "reasoning"
		}
		if recipient := str(message["recipient"]); recipient != "" && recipient != "all" {
			return "tool"
		}
	}
	if role == "tool" && (message["recipient"] == nil || message["recipient"] == "all") {
		for _, part := range array(content["parts"]) {
			p := obj(part)
			pointer := first(p["asset_pointer"], obj(p["image_asset_pointer"])["asset_pointer"])
			md := obj(p["metadata"])
			if str(pointer) != "" && (metadata["image_gen_title"] != nil || len(obj(md["generation"])) > 0 || len(obj(md["dalle"])) > 0) {
				return "assistant"
			}
		}
	}
	if role != "user" && role != "assistant" && role != "tool" {
		return "context"
	}
	return role
}

// Repair existing archives from their own raw records, so an unchanged source
// or an expired Desktop conversation does not leave generated answers hidden.
func (s *Store) recoverChatGPTRoles() error {
	s.importMu.Lock()
	defer s.importMu.Unlock()
	if row, err := one(s.DB, "SELECT value FROM settings WHERE key='chatgpt_roles_version'"); err == nil && row["value"] == "1" {
		return nil
	} else if err != nil && !errors.Is(err, errNotFound) {
		return err
	}
	rows, err := query(s.DB, `SELECT m.* FROM messages m JOIN sessions s ON s.id=m.session_id
		WHERE s.provider='ChatGPT' AND json_extract(m.metadata,'$.source_role') IS NULL
		AND ((m.role='tool' AND m.kind='multimodal_text') OR (m.role='assistant' AND m.kind='code'))`)
	if err != nil {
		return err
	}
	bySession := map[string]map[string]M{}
	for _, row := range rows {
		sid := str(row["session_id"])
		if bySession[sid] == nil {
			bySession[sid] = map[string]M{}
		}
		bySession[sid][str(row["identity"])] = row
	}
	for sid, pending := range bySession {
		var before int64 = 1<<63 - 1
		for len(pending) > 0 {
			chunks, err := query(s.DB, "SELECT id,payload FROM raw_chunks WHERE session_id=? AND id<? ORDER BY id DESC LIMIT 8", sid, before)
			if err != nil {
				return err
			}
			if len(chunks) == 0 {
				break
			}
			for _, chunk := range chunks {
				before = integer(chunk["id"])
				raw, err := s.rawBody(chunk["payload"].([]byte))
				if err != nil {
					return err
				}
				var conversation M
				if json.Unmarshal([]byte(raw), &conversation) != nil {
					continue
				}
				messages := array(conversation["messages"])
				for nid, value := range obj(conversation["mapping"]) {
					message := obj(obj(value)["message"])
					if len(message) == 0 {
						continue
					}
					message["id"] = nid
					messages = append(messages, message)
				}
				tx, err := s.Write.Begin()
				if err != nil {
					return err
				}
				for _, value := range messages {
					message := obj(value)
					identity := "node:" + str(message["id"])
					row := pending[identity]
					if row == nil {
						continue
					}
					var metadata M
					if err = json.Unmarshal([]byte(str(row["metadata"])), &metadata); err != nil {
						tx.Rollback()
						return err
					}
					metadata["source_role"], metadata["recipient"], metadata["channel"] = obj(message["author"])["role"], message["recipient"], message["channel"]
					body, err := unpack(row["body"].([]byte))
					if err == nil {
						_, err = s.message(tx, sid, identity, integer(row["position"]), chatGPTMessageRole(message), string(body), number(row["timestamp"]), str(row["kind"]), str(row["phase"]), metadata)
					}
					if err != nil {
						tx.Rollback()
						return err
					}
					delete(pending, identity)
				}
				if err = s.recount(tx, sid); err != nil {
					tx.Rollback()
					return err
				}
				if err = tx.Commit(); err != nil {
					return err
				}
				if len(pending) == 0 {
					break
				}
			}
		}
	}
	_, err = s.Write.Exec("INSERT INTO settings(key,value) VALUES ('chatgpt_roles_version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
	return err
}
