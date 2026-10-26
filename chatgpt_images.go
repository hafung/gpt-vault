package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type desktopImageSource struct {
	Reference string   `json:"reference"`
	URLs      []string `json:"urls,omitempty"`
}

type desktopImage struct {
	Reference string `json:"reference"`
	Data      string `json:"data"`
}

// Only image-bearing fields are visited; citation/source page URLs are not images.
func chatGPTImageSources(metadata M) []desktopImageSource {
	result := []desktopImageSource{}
	seen := map[string]bool{}
	add := func(ref string, urls []string) {
		if ref != "" && !seen[ref] {
			seen[ref] = true
			result = append(result, desktopImageSource{ref, urls})
		}
	}
	for _, value := range array(metadata["assets"]) {
		ref := str(obj(value)["reference"])
		if strings.HasPrefix(ref, "sediment://") || strings.HasPrefix(ref, "file-service://") {
			add(ref, nil)
		}
	}
	var visit func(any, int)
	visit = func(value any, depth int) {
		if depth > 40 {
			return
		}
		switch v := value.(type) {
		case map[string]any:
			urls := []string{}
			for _, key := range []string{"content_url", "original_content_url", "thumbnail_url", "src"} {
				if u := str(v[key]); strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
					urls = append(urls, u)
				}
			}
			if len(urls) > 0 {
				add(urls[0], urls)
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

// Reimports keep the archived bytes even when an older cache only has pointers.
func preserveChatGPTImages(metadata, previous M) {
	images := obj(previous["image_assets"])
	if len(images) == 0 {
		return
	}
	metadata["image_assets"] = images
	assets := []any{}
	seen := map[string]bool{}
	for _, asset := range append(array(metadata["assets"]), array(previous["assets"])...) {
		if ref := str(obj(asset)["reference"]); ref != "" && images[ref] != nil {
			asset = images[ref]
		}
		key := jsonText(asset)
		if !seen[key] {
			seen[key] = true
			assets = append(assets, asset)
		}
	}
	metadata["assets"] = assets
}

func (i *Importer) desktopImageJob(job desktopCaptureJob) (desktopCaptureJob, error) {
	rows, err := query(i.Store.DB, "SELECT metadata FROM messages WHERE session_id=?", "chatgpt:"+job.ID)
	if err != nil {
		return job, err
	}
	job.KnownImages = map[string]string{}
	seen := map[string]bool{}
	for _, row := range rows {
		var metadata M
		if err = json.Unmarshal([]byte(str(row["metadata"])), &metadata); err != nil {
			return job, err
		}
		for ref, id := range obj(metadata["image_assets"]) {
			job.KnownImages[ref] = str(id)
		}
		for _, source := range chatGPTImageSources(metadata) {
			if !seen[source.Reference] {
				seen[source.Reference] = true
				job.Images = append(job.Images, source)
			}
		}
	}
	return job, nil
}

func (i *Importer) importDesktopImages(job desktopCaptureJob, result desktopCaptureResult) error {
	if result.ID != job.ID || len(result.Images) > 24 {
		return errors.New("桌面图片结果无效")
	}
	i.Store.importMu.Lock()
	defer i.Store.importMu.Unlock()
	tx, err := i.Store.Write.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := query(tx, "SELECT id,metadata FROM messages WHERE session_id=?", "chatgpt:"+job.ID)
	if err != nil {
		return err
	}
	items := append([]desktopImage{}, result.Images...)
	for reference := range job.KnownImages {
		items = append(items, desktopImage{Reference: reference})
	}
	for _, item := range items {
		if len(item.Data) > 12<<20 {
			return errors.New("桌面图片超过大小限制")
		}
		var raw []byte
		var mime string
		id := job.KnownImages[item.Reference]
		if item.Data != "" {
			raw, err = base64.StdEncoding.DecodeString(item.Data)
			if err != nil {
				return errors.New("桌面图片编码无效")
			}
			mime = http.DetectContentType(raw)
			if !strings.HasPrefix(mime, "image/") {
				return errors.New("桌面下载结果不是图片")
			}
			id = hash(raw)
		} else {
			if _, err = one(tx, "SELECT id FROM assets WHERE id=?", id); errors.Is(err, errNotFound) {
				continue
			} else if err != nil {
				return err
			}
		}
		linked := false
		for _, row := range rows {
			var metadata M
			if err = json.Unmarshal([]byte(str(row["metadata"])), &metadata); err != nil {
				return err
			}
			matches := false
			for _, source := range chatGPTImageSources(metadata) {
				if source.Reference == item.Reference {
					matches = true
				}
			}
			if !matches {
				continue
			}
			images := obj(metadata["image_assets"])
			images[item.Reference] = id
			preserveChatGPTImages(metadata, M{"image_assets": images})
			assets := array(metadata["assets"])
			found := false
			for _, asset := range assets {
				found = found || str(asset) == id
			}
			if !found {
				metadata["assets"] = append(assets, id)
			}
			encoded := jsonText(metadata)
			if _, err = tx.Exec("UPDATE messages SET metadata=? WHERE id=?", encoded, row["id"]); err != nil {
				return err
			}
			row["metadata"] = encoded
			linked = true
		}
		// A deletion during the download must not leave orphaned image payloads.
		if linked && len(raw) > 0 {
			if _, err = tx.Exec("INSERT OR IGNORE INTO assets(id,mime,payload) VALUES (?,?,?)", id, mime, raw); err != nil {
				return err
			}
		}
	}
	if _, err = tx.Exec("UPDATE settings SET value=json_set(value,'$.images_attempt',?) WHERE key=?", now(), desktopCheckpointPrefix+"chatgpt:"+job.ID); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if result.PendingImages > 0 {
		i.issue(job.title, errors.New("部分图片尚未归档；引用已保留，可稍后重新同步补充"), true)
	}
	return nil
}
