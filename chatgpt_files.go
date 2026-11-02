package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

type desktopFileSource struct {
	Reference string `json:"reference"`
	MessageID string `json:"message_id"`
}

type desktopFile struct {
	Reference string `json:"reference"`
	Data      string `json:"data"`
}

var sandboxLink = regexp.MustCompile(`sandbox:/[^\s<>"\x60)\]]+`)

// Decode exactly once: encoded and literal Chinese destinations identify one file.
func sandboxReference(value string) string {
	if !strings.HasPrefix(value, "sandbox:/") || strings.HasPrefix(value, "sandbox://") {
		return ""
	}
	p, err := url.PathUnescape(strings.TrimPrefix(value, "sandbox:"))
	if err != nil || len(p) > 4096 || strings.ContainsAny(p, "\x00\r\n\\") || !utf8.ValidString(p) {
		return ""
	}
	return "sandbox:" + p
}

func chatGPTFileSources(body string, metadata M) []desktopFileSource {
	seen := map[string]bool{}
	result := []desktopFileSource{}
	add := func(value string) {
		if ref := sandboxReference(value); ref != "" && !seen[ref] {
			seen[ref] = true
			result = append(result, desktopFileSource{Reference: ref, MessageID: str(metadata["node_id"])})
		}
	}
	for _, ref := range sandboxLink.FindAllString(body, -1) {
		add(ref)
	}
	var visit func(any, int)
	visit = func(value any, depth int) {
		if depth > 40 {
			return
		}
		switch v := value.(type) {
		case map[string]any:
			for _, key := range []string{"url", "src", "source_label"} {
				add(str(v[key]))
			}
			for _, child := range v {
				visit(child, depth+1)
			}
		case []any:
			for _, child := range v {
				visit(child, depth+1)
			}
		}
	}
	visit(metadata["chatgpt_ui"], 0)
	return result
}

func preserveChatGPTFiles(metadata, previous M) {
	files := obj(previous["file_assets"])
	if len(files) == 0 {
		return
	}
	metadata["file_assets"] = files
	assets := array(metadata["assets"])
	for _, file := range files {
		id := str(obj(file)["id"])
		found := id == ""
		for _, asset := range assets {
			found = found || str(asset) == id
		}
		if !found {
			assets = append(assets, id)
		}
	}
	metadata["assets"] = assets
}

func (i *Importer) desktopFileJob(job desktopCaptureJob) (desktopCaptureJob, error) {
	rows, err := query(i.Store.DB, "SELECT body,metadata FROM messages WHERE session_id=?", "chatgpt:"+job.ID)
	if err != nil {
		return job, err
	}
	job.KnownFiles = map[string]string{}
	seen := map[string]bool{}
	for _, row := range rows {
		var metadata M
		if err = json.Unmarshal([]byte(str(row["metadata"])), &metadata); err != nil {
			return job, err
		}
		for ref, file := range obj(metadata["file_assets"]) {
			job.KnownFiles[ref] = str(obj(file)["id"])
		}
		body, err := unpack(row["body"].([]byte))
		if err != nil {
			return job, err
		}
		for _, source := range chatGPTFileSources(body, metadata) {
			if !seen[source.Reference] {
				seen[source.Reference] = true
				job.Files = append(job.Files, source)
			}
		}
	}
	return job, nil
}

func (i *Importer) importDesktopFiles(job desktopCaptureJob, result desktopCaptureResult) error {
	if result.ID != job.ID || len(result.Files) > 24 {
		return errors.New("桌面文件结果无效")
	}
	i.Store.importMu.Lock()
	defer i.Store.importMu.Unlock()
	tx, err := i.Store.Write.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := query(tx, "SELECT id,body,metadata FROM messages WHERE session_id=?", "chatgpt:"+job.ID)
	if err != nil {
		return err
	}
	items := append([]desktopFile{}, result.Files...)
	for ref := range job.KnownFiles {
		items = append(items, desktopFile{Reference: ref})
	}
	for index, item := range items {
		downloaded := index < len(result.Files)
		ref := sandboxReference(item.Reference)
		if ref == "" || ref != item.Reference || len(item.Data) > 12<<20 {
			return errors.New("桌面文件引用或大小无效")
		}
		var raw []byte
		id, contentType := job.KnownFiles[ref], ""
		if downloaded {
			raw, err = base64.StdEncoding.DecodeString(item.Data)
			if err != nil || len(raw) > 8<<20 {
				return errors.New("桌面文件编码或大小无效")
			}
			id = hash(raw)
			contentType = http.DetectContentType(raw)
			// Never serve executable markup as a same-origin document.
			if strings.HasPrefix(contentType, "text/") {
				contentType = "text/plain; charset=utf-8"
			}
		} else {
			asset, e := one(tx, "SELECT mime FROM assets WHERE id=?", id)
			if errors.Is(e, errNotFound) {
				continue
			} else if e != nil {
				return e
			}
			contentType = str(asset["mime"])
		}
		linked := false
		for _, row := range rows {
			var metadata M
			if err = json.Unmarshal([]byte(str(row["metadata"])), &metadata); err != nil {
				return err
			}
			body, err := unpack(row["body"].([]byte))
			if err != nil {
				return err
			}
			matches := false
			for _, source := range chatGPTFileSources(body, metadata) {
				matches = matches || source.Reference == ref
			}
			if !matches {
				continue
			}
			files := obj(metadata["file_assets"])
			files[ref] = M{"id": id, "name": path.Base(strings.TrimPrefix(ref, "sandbox:")), "mime": contentType}
			preserveChatGPTFiles(metadata, M{"file_assets": files})
			encoded := jsonText(metadata)
			if _, err = tx.Exec("UPDATE messages SET metadata=? WHERE id=?", encoded, row["id"]); err != nil {
				return err
			}
			row["metadata"] = encoded
			linked = true
		}
		if linked && downloaded {
			if _, err = tx.Exec("INSERT OR IGNORE INTO assets(id,mime,payload) VALUES (?,?,?)", id, contentType, raw); err != nil {
				return err
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if result.PendingFiles > 0 {
		i.issue(job.title, errors.New("部分生成文件尚未归档；可在 Desktop 中确认文件仍可打开后重新同步"), true)
	}
	return nil
}

func fileDisposition(name string) string {
	return mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(name)})
}
