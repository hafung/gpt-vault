export interface ArchivedFile { id: string; name: string; mime: string }
export type FileAssets = Record<string, ArchivedFile>;

function reference(value: string): string | null {
  if (!value.startsWith('sandbox:/') || value.startsWith('sandbox://')) return null;
  try { return 'sandbox:' + decodeURIComponent(value.slice(8)); } catch { return null; }
}

// Runs before sanitization so the sandbox scheme is never enabled globally.
export function renderFileLinks(html: string, assets: FileAssets): string {
  if (!html.includes('sandbox:')) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll<HTMLAnchorElement | HTMLImageElement>('a[href], img[src]').forEach(node => {
    const ref = reference(node.getAttribute(node.tagName === 'IMG' ? 'src' : 'href') || '');
    if (!ref) return;
    const file = assets[ref], valid = /^[a-f0-9]{64}$/.test(file?.id ?? '');
    const image = node.tagName === 'IMG';
    const label = image ? node.getAttribute('alt') || '分镜图' : node.textContent || ref.split('/').at(-1) || '生成文件';
    if (!valid) {
      const pending = document.createElement('span'); pending.className = 'attachment-reference';
      pending.textContent = label;
      const hint = document.createElement('small'); hint.textContent = '文件尚未归档，可重新同步此对话；原文件需在 ChatGPT 中仍可访问。';
      pending.append(hint); node.replaceWith(pending); return;
    }
    if (image && file.mime.startsWith('image/')) {
      const preview = document.createElement('span'); preview.className = 'dil-local-image';
      preview.dataset.assetId = file.id; preview.dataset.imageAlt = label; node.replaceWith(preview); return;
    }
    const link = document.createElement('a'); link.href = '/api/assets/' + file.id; link.textContent = label;
    link.title = file.name; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const download = document.createElement('a'); download.href = link.getAttribute('href') + '?download=' + encodeURIComponent(file.name);
    download.download = file.name; download.textContent = '下载'; download.title = '下载 ' + file.name;
    node.replaceWith(link, document.createTextNode(' · '), download);
  });
  return template.innerHTML;
}
