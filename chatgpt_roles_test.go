package main

import (
	"context"
	"encoding/json"
	"net/url"
	"testing"
)

func generatedImageMessage(id string, timestamp int) M {
	m := cacheMessage(id, "tool", "", timestamp)
	m["recipient"], m["channel"] = "all", "commentary"
	m["content"] = M{"content_type": "multimodal_text", "parts": []any{M{"asset_pointer": "sediment://" + id, "metadata": M{"generation": M{"gen_id": id}}}}}
	return m
}

func TestChatGPTGeneratedAnswersAndToolCalls(t *testing.T) {
	s := testStore(t)
	i := newImporter(s)
	q := cacheMessage("q", "user", "修改图片", 100)
	image := generatedImageMessage("image", 101)
	image["channel"] = "final" // The first answer consists entirely of this image.
	q2 := cacheMessage("q2", "user", "恢复按钮", 102)
	q2["metadata"] = M{"parent_id": "omitted-hidden-node"}
	call := cacheMessage("call", "assistant", "drawsecret", 103)
	call["recipient"], call["channel"] = "image-generator", "commentary"
	call["content"] = M{"content_type": "code", "text": "drawsecret"}
	image2 := generatedImageMessage("image2", 104)
	answer := cacheMessage("answer", "assistant", "已恢复", 105)
	answer["metadata"] = M{"parent_id": "another-hidden-node"}
	result := liveTestResult("roles", true, "", q, image, q2, call, image2, answer)
	result.Conversation["current_node"] = "answer"
	job := desktopCaptureJob{ID: "roles"}
	check(t, i.importDesktopCapture(job, result, false))
	check(t, i.importDesktopImages(job, desktopCaptureResult{ID: job.ID, Images: []desktopImage{{"sediment://image", imageFixture}, {"sediment://image2", imageFixture}}}))
	// Reimporting identical bodies must still correct old roles and their indexes.
	_, err := s.message(s.Write, "chatgpt:roles", "node:call", 3, "assistant", "drawsecret", 103, "code", "", M{})
	check(t, err)
	check(t, i.importDesktopCapture(job, result, false))
	page, err := s.messages(context.Background(), "chatgpt:roles", url.Values{})
	check(t, err)
	items := page["items"].([]M)
	if len(items) != 5 {
		t.Fatalf("default reader lost image-only answers or exposed a tool call: %v", items)
	}
	for index, item := range items {
		meta := obj(item["metadata"])
		if meta["branch"] == true {
			t.Fatal("omitted hidden parent broke the visible history", meta)
		}
		if index == 1 || index == 3 {
			if item["role"] != "assistant" || meta["source_role"] != "tool" || len(obj(meta["image_assets"])) != 1 || len(array(meta["assets"])) != 1 {
				t.Fatal("generated reply lost its role, source or archived bytes", item)
			}
		}
	}
	row, err := one(s.DB, "SELECT count(*) AS n FROM dialogue_long WHERE dialogue_long MATCH 'drawsecret'")
	check(t, err)
	if integer(row["n"]) != 0 {
		t.Fatal("tool call remained in dialogue search")
	}
	row, err = one(s.DB, "SELECT message_count,total_count FROM sessions WHERE id='chatgpt:roles'")
	check(t, err)
	if integer(row["message_count"]) != 5 || integer(row["total_count"]) != 6 {
		t.Fatal("reply counts were not corrected", row)
	}
}

func TestChatGPTRolesRecoverOfflineWithoutLosingArchivedImages(t *testing.T) {
	s := testStore(t)
	i := newImporter(s)
	image := generatedImageMessage("image", 101)
	image["content"].(M)["parts"] = append(array(obj(image["content"])["parts"]), "generatedcaption")
	call := cacheMessage("call", "assistant", "drawsecret", 100)
	call["recipient"] = "image-generator"
	call["content"] = M{"content_type": "code", "text": "drawsecret"}
	c := M{"id": "offline", "current_node": "image", "mapping": M{"call": M{"message": call}, "image": M{"message": image, "parent": "call"}}}
	_, err := i.chatgptConversation(c, "deleted-source", 1, false, "云端导出", nil)
	check(t, err)
	check(t, i.importDesktopImages(desktopCaptureJob{ID: "offline"}, desktopCaptureResult{ID: "offline", Images: []desktopImage{{"sediment://image", imageFixture}}}))
	rows, err := query(s.DB, "SELECT * FROM messages WHERE session_id='chatgpt:offline'")
	check(t, err)
	for _, row := range rows {
		var meta M
		check(t, json.Unmarshal([]byte(str(row["metadata"])), &meta))
		delete(meta, "source_role")
		body, err := unpack(row["body"].([]byte))
		check(t, err)
		oldRole := "assistant"
		if row["identity"] == "node:image" {
			oldRole = "tool"
		}
		_, err = s.message(s.Write, "chatgpt:offline", str(row["identity"]), integer(row["position"]), oldRole, body, number(row["timestamp"]), str(row["kind"]), "", meta)
		check(t, err)
	}
	check(t, s.recoverChatGPTRoles())
	check(t, s.recoverChatGPTRoles())
	page, err := s.messages(context.Background(), "chatgpt:offline", url.Values{})
	check(t, err)
	items := page["items"].([]M)
	if len(items) != 1 || items[0]["body"] != "generatedcaption" || len(obj(obj(items[0]["metadata"])["image_assets"])) != 1 || count(t, s, "assets") != 1 {
		t.Fatal("offline recovery did not preserve the generated reply", items)
	}
	for query, want := range map[string]int64{"drawsecret": 0, "generatedcaption": 1} {
		row, err := one(s.DB, "SELECT count(*) AS n FROM dialogue_long WHERE dialogue_long MATCH ?", query)
		check(t, err)
		if integer(row["n"]) != want {
			t.Fatal("offline recovery left incorrect dialogue indexes", query, row)
		}
	}
}

func TestChatGPTRoleKeepsOtherToolsAndHiddenImagesTechnical(t *testing.T) {
	image := generatedImageMessage("image", 1)
	image["metadata"] = M{"is_visually_hidden_from_conversation": true}
	if chatGPTMessageRole(image) != "context" {
		t.Fatal("visually hidden image exposed")
	}
	image["metadata"] = M{}
	obj(obj(image["content"])["parts"].([]any)[0])["metadata"] = M{}
	if chatGPTMessageRole(image) != "tool" {
		t.Fatal("ordinary tool attachment promoted to a reply")
	}
	code := cacheMessage("code", "assistant", "example", 2)
	code["recipient"] = "all"
	code["content"] = M{"content_type": "code", "text": "example"}
	if chatGPTMessageRole(code) != "assistant" {
		t.Fatal("code answer addressed to the user hidden")
	}
}

func TestChatGPTLinearPagesReconnectOmittedParentsInTimeOrder(t *testing.T) {
	s := testStore(t)
	i := newImporter(s)
	q := cacheMessage("q", "user", "旧问题", 100)
	a := cacheMessage("a", "assistant", "旧回答", 101)
	q2 := cacheMessage("q2", "user", "新问题", 102)
	q2["metadata"] = M{"parent_id": "omitted"}
	a2 := cacheMessage("a2", "assistant", "新回答", 103)
	// Capture reads the newest page first, then appends older pages.
	c := M{"id": "page-order", "current_node": "a2", "messages": []any{q2, a2, q, a}}
	_, err := i.chatgptConversation(c, "cache", 1, false, "Windows", nil)
	check(t, err)
	page, err := s.messages(context.Background(), "chatgpt:page-order", url.Values{})
	check(t, err)
	for index, item := range page["items"].([]M) {
		meta := obj(item["metadata"])
		if item["body"] != []string{"旧问题", "旧回答", "新问题", "新回答"}[index] || meta["branch"] == true {
			t.Fatal("pagination created a false branch or reordered visible messages", item)
		}
	}
}
