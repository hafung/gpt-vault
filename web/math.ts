import { marked } from 'marked';
import katex from 'katex';

interface MathToken {
  type: 'displayMath' | 'inlineMath';
  raw: string;
  text: string;
  display: boolean;
}

const escapeHTML = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function mathAt(source: string, bare = false): MathToken | undefined {
  const match = /^(?:\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$)/.exec(source);
  if (match) return { type: 'inlineMath', raw: match[0], text: match[1] ?? match[2] ?? match[3], display: match[2] === undefined };
  // Some copied messages lose the slashes around a standalone display block.
  // Require a TeX command so ordinary brackets and Markdown links stay literal.
  const block = bare && /^\[[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\](?=[ \t]*(?:\r?\n|$))/.exec(source);
  if (block && /\\(?:text|frac|sqrt|sum|int|begin)\b/.test(block[1])) {
    return { type: 'displayMath', raw: block[0], text: block[1].replace(/(?<!\\)%/g, '\\%'), display: true };
  }
}

function renderMath(token: MathToken): string {
  try {
    const html = katex.renderToString(token.text, {
      displayMode: token.display, output: 'mathml', throwOnError: true,
      trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20,
    // DOMPurify unwraps annotation tags, leaving duplicate TeX text in the math.
    // Keep the semantic MathML and discard KaTeX's inert source annotation.
    }).replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/g, '');
    return `<span class="rendered-math${token.display ? ' display-math' : ''}">${html}</span>`;
  } catch {
    // A malformed or unsupported formula must not hide the rest of a message.
    return escapeHTML(token.raw);
  }
}

// Tokenize before Markdown consumes \[ and \(. Marked handles code blocks and
// spans before reaching their contents, including nested/longer code fences.
marked.use({ extensions: [{
  name: 'displayMath', level: 'block',
  start(source) { const i = source.search(/^ {0,3}(?:\\\[|\$\$|\[[ \t]*$)/m); return i < 0 ? undefined : i; },
  tokenizer(source) {
    const indent = /^ {0,3}/.exec(source)![0];
    const token = mathAt(source.slice(indent.length), true);
    if (!token?.display) return;
    const end = /^[ \t]*(?:\r?\n|$)/.exec(source.slice(indent.length + token.raw.length));
    if (end) return { ...token, type: 'displayMath', raw: indent + token.raw + end[0] };
  },
  renderer(token) { return renderMath(token as MathToken) + '\n'; },
}, {
  name: 'inlineMath', level: 'inline',
  start(source) { const i = source.search(/\\[[(]|\$\$/); return i < 0 ? undefined : i; },
  tokenizer(source) { return mathAt(source); },
  renderer(token) { return renderMath(token as MathToken); },
}] });

// DIL parsing and interpolation must treat both Markdown code and TeX as
// opaque. In particular, a shorter fence cannot close a longer one.
export function markdownLiteralEnd(source: string, start: number): number {
  const rest = source.slice(start), lineStart = start === 0 || source[start - 1] === '\n';
  const fence = lineStart && /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(rest);
  if (fence) {
    const close = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}[ \\t]*(?:\\r?\\n|$)', 'm');
    const match = close.exec(rest.slice(fence[0].length));
    return match ? start + fence[0].length + match.index + match[0].length : source.length;
  }
  if (rest[0] === '`' && source[start - 1] !== '`') {
    const run = /^`+/.exec(rest)![0];
    for (const match of rest.slice(run.length).matchAll(/`+/g)) {
      if (match[0].length === run.length) return start + run.length + match.index + run.length;
    }
  }
  if (rest[0] === '\\' || rest.startsWith('$$') || (lineStart && rest[0] === '[')) {
    const math = mathAt(rest, lineStart);
    if (math) return start + math.raw.length;
  }
  return start;
}

export function mapMarkdownText(source: string, transform: (text: string) => string): string {
  let result = '', last = 0;
  for (let i = 0; i < source.length;) {
    const end = markdownLiteralEnd(source, i);
    if (end > i) { result += transform(source.slice(last, i)) + source.slice(i, end); i = last = end; }
    else if (source[i] === '\\' && i + 1 < source.length) i += 2;
    else i++;
  }
  return result + transform(source.slice(last));
}
