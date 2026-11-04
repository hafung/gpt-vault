import { markdownLiteralEnd } from './math';

const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function attributes(source: string): Record<string, string> | undefined {
  const result: Record<string, string> = Object.create(null);
  while (source.trim()) {
    const match = /^\s*([a-z_]+)\s*=\s*("(?:\\.|[^"\\])*")\s*/i.exec(source);
    if (!match) return;
    try { result[match[1]] = JSON.parse(match[2]); } catch { return; }
    source = source.slice(match[0].length);
  }
  if (/^\d+$/.test(result.id ?? '') && /^[a-z_]+$/.test(result.variant ?? '')) return result;
}

// Recognize complete, standalone writing directives only. Code and TeX stay
// opaque, including code examples containing a line that looks like a closer.
export function renderChatGPTWriting(body: string, slot: (html: string) => string): string {
  if (!body.includes(':::writing{')) return body;
  let result = '';
  for (let i = 0; i < body.length;) {
    const literal = markdownLiteralEnd(body, i);
    if (literal > i) { result += body.slice(i, literal); i = literal; continue; }
    if (body[i] === '\\' && i + 1 < body.length) { result += body.slice(i, i + 2); i += 2; continue; }
    const open = (i === 0 || body[i - 1] === '\n') && /^ {0,3}:::writing\{([^\r\n]*)\}[ \t]*\r?\n/.exec(body.slice(i));
    const attrs = open ? attributes(open[1]) : undefined;
    if (!open || !attrs) { result += body[i++]; continue; }
    const start = i + open[0].length;
    let close: RegExpExecArray | null = null, end = start;
    for (; end < body.length;) {
      const literalEnd = markdownLiteralEnd(body, end);
      if (literalEnd > end) { end = literalEnd; continue; }
      if (end === 0 || body[end - 1] === '\n') {
        close = /^ {0,3}:::[ \t]*(?:\r?\n|$)/.exec(body.slice(end));
        if (close) break;
      }
      end++;
    }
    // An incomplete streaming/truncated block must never consume later prose.
    if (!close) { result += body.slice(i); break; }
    const title = attrs.title || attrs.subject || '写作内容';
    // Only the wrapper uses HTML slots. Its content follows the existing
    // Markdown/DIL/citation pipeline and the final shared sanitizer.
    result += slot(`<section class="chatgpt-writing${attrs.variant === 'chat_message' ? ' chatgpt-writing-chat' : ''}" aria-label="${esc(title)}"><header class="chatgpt-writing-header"><strong>${esc(title)}</strong><button type="button" class="writing-copy" aria-label="复制写作内容">复制</button></header><div class="chatgpt-writing-body">`);
    result += body.slice(start, end);
    result += slot('</div></section>');
    i = end + close[0].length;
  }
  return result;
}
