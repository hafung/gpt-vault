package main

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

func TestCodexImageMirrorsAndPascalItems(t *testing.T) {
	for _, reverse := range []bool{false, true} {
		t.Run(map[bool]string{false: "response-first", true: "item-first"}[reverse], func(t *testing.T) {
			s := testStore(t)
			i := newImporter(s)
			image := M{"type": "input_image", "image_url": "data:image/png;base64,aGVsbG8="}
			user := M{"type": "UserMessage", "id": "u1", "content": []any{M{"type": "local_image", "path": "/missing/echo-vault-test.png"}, M{"type": "text", "text": "查看图片"}}}
			agent := M{"type": "AgentMessage", "id": "a1", "content": []any{M{"type": "Text", "text": "已查看\n"}}, "phase": "commentary"}
			response := responseEvent("user", "")
			obj(response["payload"])["content"] = []any{M{"type": "input_text", "text": `<image name=[Image #1] path="/tmp/example.png">`}, image, M{"type": "input_text", "text": "</image>"}, M{"type": "input_text", "text": "查看图片"}}
			events := []M{response, {"type": "event_msg", "payload": M{"type": "item_completed", "item": user}}, {"type": "event_msg", "payload": M{"type": "item_completed", "item": agent}}, responseEvent("assistant", "已查看\n")}
			if reverse {
				events[0], events[1] = events[1], events[0]
				events[2], events[3] = events[3], events[2]
			}
			entry := fixture(t, t.TempDir(), "images", events...)
			for _, full := range []bool{false, true, true} {
				check(t, i.rollout(entry, map[string]M{}, full))
				if count(t, s, "messages") != 2 {
					t.Fatal("mirrors duplicated", full)
				}
			}
			page, err := s.messages(context.Background(), "images", url.Values{})
			check(t, err)
			messages := page["items"].([]M)
			if messages[0]["body"] != "查看图片" || messages[1]["body"] != "已查看\n" || messages[1]["phase"] != "commentary" {
				t.Fatal(messages)
			}
			stored, e := one(s.DB, "SELECT metadata FROM messages WHERE session_id='images' AND identity='item:u1'")
			check(t, e)
			if !strings.Contains(str(stored["metadata"]), hash([]byte("hello"))) {
				t.Fatal("inline image lost when local file is missing on reimport")
			}
			if count(t, s, "assets") != 1 {
				t.Fatal("image lost or duplicated")
			}
			check(t, s.recoverCodexMessages())
			check(t, s.recoverCodexMessages())
		})
	}
	literal := `<image name=[Image #1] path="/tmp/example.png">` + "\n</image>"
	if codexResponseText([]any{M{"type": "input_text", "text": literal}}) != literal {
		t.Fatal("literal image markup changed")
	}
}

func TestCodexExistingMirrorsRecoverWithoutSources(t *testing.T) {
	s := testStore(t)
	check(t, s.session(s.Write, "old", M{"title": "历史", "provider": "Codex"}))
	user := M{"type": "UserMessage", "id": "u", "content": []any{M{"type": "text", "text": "问题"}}}
	_, err := s.message(s.Write, "old", "item:u", 10, "tool", jsonText(user), 1, "UserMessage", "", M{})
	check(t, err)
	_, err = s.message(s.Write, "old", "response:11:old", 11, "user", "<image name=[Image #1] path=\"/tmp/example.png\">\n</image>\n问题", 1, "message", "", M{"assets": []any{"image-bytes"}})
	check(t, err)
	_, err = s.message(s.Write, "old", "item:a", 13, "assistant", "答复\n", 1, "agentMessage", "final", M{})
	check(t, err)
	_, err = s.message(s.Write, "old", "response:14:old", 14, "assistant", "答复\n", 1, "message", "final", M{})
	check(t, err)
	// An identical question in a distinct turn must survive.
	_, err = s.message(s.Write, "old", "item:u2", 20, "user", "问题", 1, "userMessage", "", M{})
	check(t, err)
	check(t, s.recoverCodexMessages())
	check(t, s.recoverCodexMessages())
	if count(t, s, "messages") != 3 {
		t.Fatal("recovery removed a real repeat or left mirrors")
	}
	row, err := one(s.DB, "SELECT metadata FROM messages WHERE identity='item:u'")
	check(t, err)
	if !strings.Contains(str(row["metadata"]), "image-bytes") {
		t.Fatal("recovery lost image metadata")
	}
	for _, table := range []string{"search_long", "search_short", "dialogue_long", "dialogue_short"} {
		if count(t, s, table) != 3 {
			t.Fatal("stale search entries", table)
		}
	}
}
