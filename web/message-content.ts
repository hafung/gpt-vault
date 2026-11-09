import { marked } from 'marked';
import { decorateMermaidDiagrams } from './mermaid';
import DOMPurify from 'dompurify';
import { staticValue, dilFunction, callDil, isDilFunction, type Scope } from './dil-values';
import { markdownLiteralEnd, mapMarkdownText } from './math';
import { renderFileLinks, type FileAssets } from './chatgpt-files';
import { renderChatGPTMarkers } from './chatgpt-markers';
import { renderChatGPTWriting } from './chatgpt-writing';
import { createElement, Folder, FileCode, Copy, RotateCcw } from 'lucide';

type Data = Record<string, unknown>;
export interface ChatGPTUI {
  model_dil_v2?: { code?: string; constants?: Data; fallbackMarkdown?: string; appData?: { opGenui?: { componentResults?: Data; modelDataBindings?: Data } } };
  genui_components?: { type?: string; component_resolution_id?: string }[];
  content_references?: Data[];
  search_result_groups?: Data[];
}
interface Element { name: string; attrs: string; children: Part[] }
type Part = string | Element;
const containers = new Set(['box', 'row', 'column', 'grid', 'grid-item', 'text', 'title', 'caption', 'badge', 'bold', 'italic', 'link', 'list', 'list-item', 'table', 'table-head', 'table-body', 'table-row', 'table-cell', 'button', 'label', 'form', 'radio-group', 'radio', 'checkbox', 'select', 'option', 'accordion', 'accordion-item', 'callout', 'card', 'tabs', 'tab', 'svg', 'g', 'appblock']);
const singles = new Set(['asyncimage', 'asyncimagegroup', 'entity', 'cite', 'memorycite', 'icon', 'divider', 'separator', 'image', 'slider', 'input', 'progress', 'chart', 'bar-chart', 'line-chart', 'pie-chart', 'map', 'rect', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const inline = new Set(['entity', 'cite', 'memorycite', 'icon', 'badge', 'bold', 'italic', 'link']);
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const data = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
export function safeRemoteURL(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}

// JSX attributes can contain strings, nested objects and arrows with `>` in them.
function balancedEnd(source: string, start: number, tag: boolean): number {
  let braces = 0, quote = '';
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') braces++;
    else if (c === '}') { if (--braces === 0 && !tag) return i + 1; }
    else if (c === '>' && braces === 0 && tag) return i + 1;
  }
  return -1;
}

function parts(source: string): Part[] {
  const root: Element = { name: '', attrs: '', children: [] }, stack = [root];
  const lastIndex = (name: string) => { for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) return i; return -1; };
  const append = (value: Part) => { const children = stack.at(-1)!.children; if (typeof value === 'string' && typeof children.at(-1) === 'string') children[children.length - 1] += value; else children.push(value); };
  for (let i = 0; i < source.length;) {
    const literalEnd = markdownLiteralEnd(source, i);
    if (literalEnd > i) { append(source.slice(i, literalEnd)); i = literalEnd; continue; }
    if (source[i] === '\\' && i + 1 < source.length) { append(source.slice(i, i + 2)); i += 2; continue; }
    if (source[i] === '<') {
      const match = /^<(\/?)([A-Za-z][\w-]*)(?=[\s/>])/.exec(source.slice(i));
      const name = match?.[2].toLowerCase();
      if (match && name && (containers.has(name) || singles.has(name))) {
        const end = balancedEnd(source, i, true);
        if (end < 0) { append(esc(source.slice(i))); break; }
        const raw = source.slice(i, end);
        if (match[1]) {
          const index = lastIndex(name);
          if (index > 0) stack.length = index;
        } else {
          const element: Element = { name, attrs: raw.slice(match[0].length).replace(/\/?\s*>$/, ''), children: [] };
          append(element);
          if (!/\/\s*>$/.test(raw) && !singles.has(name)) stack.push(element);
        }
        i = end; continue;
      }
    }
    if (source[i] === '{' && /^\{(?:@body\b|#(?:each|if)\b|\/(?:each|if)\b|:else\b)/.test(source.slice(i))) {
      const end = balancedEnd(source, i, false);
      if (end < 0) { append(esc(source.slice(i))); break; }
      const directive = source.slice(i + 1, end - 1);
      if (/^\//.test(directive)) {
        const index = lastIndex(directive.slice(1).trim());
        if (index > 0) stack.length = index;
      } else if (directive.startsWith(':else')) {
        const index = lastIndex('if');
        if (index > 0) { stack.length = index + 1; const el: Element = { name: 'else', attrs: directive.slice(5).trim(), children: [] }; append(el); stack.push(el); }
      } else {
        const [name] = directive.slice(1).split(/\s/), el: Element = { name, attrs: directive.slice(name.length + 1).trim(), children: [] };
        append(el); if (name !== 'body') stack.push(el);
      }
      i = end; continue;
    }
    append(source[i++]);
  }
  return root.children;
}

function attributes(source: string, scope: Scope): Data {
  const result = Object.create(null) as Data;
  for (let i = 0; i < source.length;) {
    const match = /^\s*([\w-]+)\s*(=\s*)?/.exec(source.slice(i));
    if (!match) break;
    i += match[0].length; const name = match[1];
    if (!match[2]) { result[name] = true; continue; }
    const start = i, c = source[i];
    if (c === '{') { const end = balancedEnd(source, i, false); if (end < 0) break; result[name] = staticValue(source.slice(i + 1, end - 1), scope); i = end; }
    else if (c === '"' || c === "'") { i++; while (i < source.length && source[i] !== c) { if (source[i] === '\\') i++; i++; } i++; result[name] = staticValue(source.slice(start, i), scope); }
    else { while (i < source.length && !/\s/.test(source[i])) i++; const raw = source.slice(start, i); result[name] = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw; }
  }
  return result;
}

function dedent(source: string): string {
  const lines = source.replace(/^\s*\n/, '').split('\n');
  const indents = lines.filter(line => line.trim()).map(line => /^ */.exec(line)![0].length);
  const amount = Math.min(...indents, 0x7fffffff);
  return lines.map(line => line.slice(Math.min(amount, /^ */.exec(line)![0].length))).join('\n').trim();
}

interface DilRuntime { states: Record<string, unknown>; handlers: unknown[]; copy?: (text: string) => void }
export function renderMessageContent(body: string, ui?: ChatGPTUI, chatGPT = false, imageAssets: Record<string, string> = {}, fileAssets: FileAssets = {}, runtime?: DilRuntime): string {
  const original = body, groups: string[] = [];
  function imageFigure(item: Data, fallback = '回答中的图片'): string {
    const urls = [item.content_url, item.original_content_url, item.thumbnail_url, item.src, item.url];
    const sandbox = urls.find(value => typeof value === 'string' && value.startsWith('sandbox:/'));
    if (sandbox) return `<figure class="dil-image"><img src="${esc(sandbox)}" alt="${esc(text(item.title ?? item.alt) || fallback)}"></figure>`;
    const url = urls.map(safeRemoteURL).find(Boolean);
    const id = urls.map(value => imageAssets[text(value)]).find(value => /^[a-f0-9]{64}$/.test(value ?? ''));
    const label = text(item.title ?? item.alt) || fallback, source = safeRemoteURL(item.url);
    const preview = id ? `<span class="dil-local-image" data-asset-id="${id}" data-image-alt="${esc(label)}">正在读取本地图片…</span>` : url ? `<button type="button" class="dil-load-image" data-image-url="${esc(url)}" data-image-alt="${esc(label)}">加载图片</button>` : '<span>图片未包含在存档中</span>';
    return `<figure class="dil-image"><div class="dil-image-preview">${preview}</div><figcaption>${esc(label)}${source ? ` <a href="${esc(source)}">图片来源</a>` : ''}</figcaption></figure>`;
  }
  if (chatGPT) body = mapMarkdownText(body, prose => prose.replace(/\uE200image_group\uE202([\s\S]*?)\uE201/g, (raw, payload: string) => {
    let request: Data;
    try { request = data(JSON.parse(payload)); } catch { return '<span class="attachment-reference">图片组格式无法解析，原始内容已保留</span>'; }
    const refs = Array.isArray(request.image_refs) ? request.image_refs : [];
    const candidates = (ui?.content_references ?? []).filter(ref => ref.type === 'image_group');
    const reference = candidates.find(ref => ref.matched_text === raw) ?? candidates.find(ref => Array.isArray(ref.refs) && ref.refs.some(value => {
      const id = data(value); return refs.includes(`turn${id.turn_index}${id.ref_type}${id.ref_index}`);
    }));
    const images = Array.isArray(reference?.images) ? reference.images : [];
    const html = images.length ? images.slice(0, 24).map(value => imageFigure(data(data(value).image_result ?? value))).join('') : '<span class="attachment-reference">图片组的地址未包含在存档中，可重新同步补充</span>';
    groups.push(`<div class="chatgpt-image-group">${html}</div>`);
    return `\n\n\uE000EVIMAGE${groups.length - 1}\uE001\n\n`;
  }));
  if (chatGPT) body = renderChatGPTMarkers(body, ui, (html, block) => {
    groups.push(html);
    const marker = `\uE000EVIMAGE${groups.length - 1}\uE001`;
    return block ? `\n\n${marker}\n\n` : marker;
  });
  if (chatGPT) body = renderChatGPTWriting(body, html => {
    groups.push(html);
    return `\n\n\uE000EVIMAGE${groups.length - 1}\uE001\n\n`;
  });
  const sanitize = (html: string) => DOMPurify.sanitize(renderFileLinks(html.replace(/<p>(\uE000EVIMAGE\d+\uE001)<\/p>/g, '$1').replace(/\uE000EVIMAGE(\d+)\uE001/g, (_, index: string) => groups[Number(index)] ?? ''), fileAssets), { FORBID_TAGS: ['img', 'style', 'iframe'], FORBID_ATTR: ['style'] });
  const dil = ui?.model_dil_v2;
  if (!dil && !(chatGPT && /<\/?(?:box|row|grid|grid-item|text|title|caption|badge|AsyncImage|AsyncImageGroup|Entity|Cite|Link|AppBlock)\b|\{(?:@body|#each|#if)\b/.test(body))) return sanitize(marked.parse(body, { async: false }) as string);
  const tree = parts(body || dil?.fallbackMarkdown || '');
  // Merely mentioning DIL inside a Markdown code example doesn't change modes.
  if (!tree.some(node => typeof node !== 'string')) return sanitize(marked.parse(body || dil?.fallbackMarkdown || '', { async: false }) as string);
  const resolved = dil?.appData?.opGenui?.componentResults ?? {};
  const order: string[] = [];
  for (const match of (dil?.code ?? '').matchAll(/"__resolutionId"\s*:\s*__dilConstants\["([^"]+)"\]/g)) {
    const id = text(dil?.constants?.[match[1]]); if (id && !order.includes(id)) order.push(id);
  }
  if (!order.length) for (const component of ui?.genui_components ?? []) if (component.component_resolution_id) order.push(component.component_resolution_id);
  const ids = order.length ? order : Object.keys(resolved);
  const queues = new Map<string, Data[]>();
  for (const id of ids) {
    const component = data(resolved[id]), name = text(component.componentName).toLowerCase();
    if (name) queues.set(name, [...(queues.get(name) ?? []), data(component.state)]);
  }
  const cursors = new Map<string, number>();
  const getState = (name: string) => { const index = cursors.get(name) ?? 0; cursors.set(name, index + 1); return queues.get(name)?.[index] ?? {}; };
  const scope = Object.assign(Object.create(null), dil?.appData?.opGenui?.modelDataBindings ?? {}) as Scope;
  const live: DilRuntime = runtime ?? { states: Object.create(null), handlers: [] };
  live.handlers = [];
  scope.GenUI = { copy: dilFunction(([value]) => { if (typeof value === 'string') live.copy?.(value); }) };
  let stateIndex = 0;
  let limited = false, count = 0;
  function markdown(source: string, context: Scope, inlineOnly = false): string {
    source = mapMarkdownText(source, prose => prose.replace(/\{([^{}\n]+)\}/g, (raw, expression: string) => {
      const value = staticValue(expression, context);
      if (value === undefined || typeof value === 'object') { limited = true; return '<code>' + esc(raw) + '</code>'; }
      return esc(value).replace(/([\\`*_[\]#])/g, '\\$1');
    }));
    return inlineOnly ? marked.parseInline(source, { async: false, breaks: false }) as string : marked.parse(source, { async: false }) as string;
  }
  function children(nodes: Part[], context: Scope, nested = true, depth = 0): string {
    if (depth > 40 || count > 5000) { limited = true; return '<p>内容较长，请查看原始内容。</p>'; }
    const slots: string[] = [];
    let source = '';
    for (const node of nodes) {
      if (typeof node === 'string') source += node;
      else {
        count++;
        const html = element(node, context, depth + 1);
        const marker = '\uE000EV' + slots.length + '\uE001';
        slots.push(html);
        source += marker;
      }
    }
    source = nested ? dedent(source) : source;
    const elements = nodes.filter((node): node is Element => typeof node !== 'string');
    // A component in a Markdown table belongs to its cell, even when it
    // normally renders as a block. Blank lines here would split the table.
    const tableSlots = new Set<string>();
    if (elements.length) marked.walkTokens(marked.lexer(source), token => {
      if (token.type === 'table') for (const match of token.raw.matchAll(/\uE000EV\d+\uE001/g)) tableSlots.add(match[0]);
    });
    source = source.replace(/\uE000EV(\d+)\uE001/g, (marker, index: string) => inline.has(elements[Number(index)].name) || tableSlots.has(marker) ? marker : '\n\n' + marker + '\n\n');
    let html = markdown(source, context);
    html = html.replace(/<p>(\uE000EV\d+\uE001)<\/p>/g, '$1');
    return html.replace(/\uE000EV(\d+)\uE001/g, (_, index: string) => slots[Number(index)] ?? '');
  }
  function image(attrs: Data, state: Data): string {
    const images = Array.isArray(state.images) ? state.images : [attrs];
    return images.slice(0, 12).map(value => imageFigure(data(value), text(attrs.alt ?? attrs.query) || '回答中的图片')).join('');
  }
  function vector(nodes: Part[], context: Scope, depth: number): string {
    if (depth > 40 || count > 5000) { limited = true; return ''; }
    const allowed = new Set(['svg', 'g', 'text', 'title', 'rect', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
    const props = new Set(['viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fillOpacity', 'stroke', 'strokeWidth', 'strokeOpacity', 'strokeLinecap', 'strokeLinejoin', 'fontSize', 'fontWeight', 'textAnchor', 'opacity', 'transform']);
    return nodes.map(node => {
      if (typeof node === 'string') return esc(node.replace(/\{([^{}]+)\}/g, (raw, expression: string) => text(staticValue(expression, context)) || raw));
      count++;
      if (node.name === 'each') {
        const match = /^([\s\S]+)\s+as\s+([\w$]+)(?:\s*,\s*([\w$]+))?$/.exec(node.attrs), values = match && staticValue(match[1], context);
        if (match && Array.isArray(values)) return values.slice(0, 100).map((value, index) => vector(node.children, Object.assign(Object.create(null), context, { [match[2]]: value, ...(match[3] ? { [match[3]]: index } : {}) }), depth + 1)).join('');
        limited = true; return vector(node.children, context, depth + 1);
      }
      if (node.name === 'if') {
        const condition = staticValue(node.attrs, context);
        if (condition === undefined) limited = true;
        const other = node.children.find(part => typeof part !== 'string' && part.name === 'else') as Element | undefined;
        return vector(condition !== undefined && !condition ? other?.children ?? [] : node.children.filter(part => part !== other), context, depth + 1);
      }
      if (!allowed.has(node.name)) { limited = true; return vector(node.children, context, depth + 1); }
      const attrs = attributes(node.attrs, context);
      const serialized = Object.entries(attrs).filter(([key, value]) => props.has(key) && (typeof value === 'string' || typeof value === 'number') && !/url\s*\(/i.test(String(value))).map(([key, value]) => ` ${key === 'viewBox' ? key : key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}="${esc(value)}"`).join('');
      return `<${node.name}${serialized}>${vector(node.children, context, depth + 1)}</${node.name}>`;
    }).join('');
  }
  function element(node: Element, context: Scope, depth: number): string {
    if (depth > 40 || count > 5000) { limited = true; return '<p>内容较长，请查看原始内容。</p>'; }
    const a = attributes(node.attrs, context), name = node.name;
    if (name === 'svg') return vector([node], context, depth);
    if (name === 'body') {
      const state = /^const\s+\[\s*([\w$]+)\s*,\s*([\w$]+)\s*\]\s*=\s*DIL\.useState\(([\s\S]*)\)\s*;?$/.exec(node.attrs);
      const variable = /^(?:const|let)\s+([\w$]+)\s*=\s*([\s\S]*?)\s*;?$/.exec(node.attrs);
      if (state) {
        const id = String(stateIndex++);
        if (!Object.hasOwn(live.states, id)) live.states[id] = staticValue(state[3], context);
        context[state[1]] = live.states[id];
        context[state[2]] = dilFunction(([value]) => {
          const next = isDilFunction(value) ? callDil(value, [live.states[id]]) : value;
          if (next !== undefined && (typeof next === 'number' && Number.isFinite(next) || typeof next === 'boolean' || typeof next === 'string' || Array.isArray(next) && next.length <= 1000)) live.states[id] = next;
        });
      }
      else if (variable) context[variable[1]] = staticValue(variable[2], context);
      else limited = true;
      return '';
    }
    if (name === 'each') {
      const match = /^([\s\S]+)\s+as\s+([\w$]+)(?:\s*,\s*([\w$]+))?$/.exec(node.attrs);
      const values = match && staticValue(match[1], context);
      if (match && Array.isArray(values)) return values.slice(0, 100).map((value, index) => children(node.children, Object.assign(Object.create(null), context, { [match[2]]: value, ...(match[3] ? { [match[3]]: index } : {}) }), true, depth)).join('');
      limited = true; return children(node.children, context, true, depth);
    }
    if (name === 'if') {
      const condition = staticValue(node.attrs, context), other = node.children.find(part => typeof part !== 'string' && part.name === 'else') as Element | undefined;
      if (condition === undefined) limited = true;
      if (condition !== undefined && !condition) return other ? other.attrs.startsWith('if ') ? element({ ...other, name: 'if', attrs: other.attrs.slice(3) }, context, depth) : children(other.children, context, true, depth) : '';
      return children(node.children.filter(part => part !== other), context, true, depth);
    }
    if (name === 'else') return '';
    if (name === 'asyncimage' || name === 'asyncimagegroup' || name === 'image') return image(a, getState(name));
    if (name === 'entity') { const state = getState(name); return `<span class="dil-entity">${esc(state.value ?? a.value ?? a.name ?? '实体')}</span>`; }
    if (name === 'cite' || name === 'memorycite') {
      const state = getState(name), sources = Array.isArray(state.items) ? state.items : Array.isArray(state.citations) ? state.citations : Array.isArray(state.sources) ? state.sources : [];
      const urls: { url: string; title: string }[] = [];
      const refs = Array.isArray(a.refs) ? a.refs : [];
      for (const value of sources) { const item = data(value), url = safeRemoteURL(item.url); if (url) urls.push({ url, title: text(item.title) || '来源' }); }
      for (const group of ui?.search_result_groups ?? []) for (const value of Array.isArray(group.entries) ? group.entries : Array.isArray(group.search_results) ? group.search_results : []) {
        const item = data(value), url = safeRemoteURL(item.url);
        const ref = data(item.ref_id), id = text(item.ref_id ?? item.ref) || (ref.turn_index !== undefined ? `turn${ref.turn_index}${ref.ref_type}${ref.ref_index}` : '');
        if (url && refs.includes(id)) urls.push({ url, title: text(item.title) || '来源' });
      }
      return urls.length ? `<span class="dil-citations">${urls.filter((v, i, all) => all.findIndex(other => other.url === v.url) === i).map((v, i) => `<a href="${esc(v.url)}" title="${esc(v.title)}">[${i + 1}]</a>`).join(' ')}</span>` : `<span class="dil-citations" title="${esc(refs.join(', '))}">[来源引用]</span>`;
    }
    const presentation = ` data-dil-presentation="${esc(JSON.stringify(Object.fromEntries(['color','weight','size','tabularNums'].filter(key=>a[key] !== undefined).map(key=>[key,a[key]]))))}"`;
    if (name === 'icon') {
      const glyph = a.name === 'folder' ? Folder : a.name === 'file-code' ? FileCode : a.name === 'copy' ? Copy : a.name === 'rotate-ccw' ? RotateCcw : undefined;
      const svg = glyph ? createElement(glyph) : undefined;
      if (svg) { svg.setAttribute('width', '1em'); svg.setAttribute('height', '1em'); svg.setAttribute('stroke-width', '1.8'); }
      return `<span class="dil-icon" aria-hidden="true"${presentation}>${svg?.outerHTML ?? esc(({ 'arrow-down': '↓', 'arrow-right': '→', 'arrow-down-up': '↕', check: '✓', star: '★', zap: 'ϟ' } as Record<string, string>)[text(a.name)] ?? '◇')}</span>`;
    }
    if (name === 'divider' || name === 'separator') return '<hr>';
    // Text-only rows use JSX line breaks as spacing. Keep their items in the
    // flex row instead of turning each source line into a Markdown hard break.
    // Rows containing cards, images or block Markdown retain the normal path.
    const compactRow = name === 'row' && node.children.every(child => typeof child === 'string'
      ? marked.lexer(dedent(child)).every(token => token.type === 'paragraph' || token.type === 'space') && !/\n\s*\n/.test(child.trim())
      : inline.has(child.name) || child.name === 'text' || child.name === 'caption');
    // Titles and explicitly inline text must share a line without Markdown
    // paragraph wrappers splitting the heading around nested components.
    const inlineTitle = name === 'title' && node.children.some(child => typeof child !== 'string' && child.name === 'text' && attributes(child.attrs, context).inline === true);
    if (inlineTitle || name === 'text' && a.inline === true) {
      const content = node.children.map(child => typeof child === 'string'
        ? markdown(dedent(child), context, true)
        : (count++, element(child, context, depth + 1))).join('');
      return name === 'title' ? `<h3 class="dil-title"${presentation}>${content}</h3>` : `<span class="dil-text dil-inline"${presentation}>${content}</span>`;
    }
    const content = compactRow ? node.children.map(child => {
      if (typeof child === 'string') return child.trim() ? `<span class="dil-row-copy">${markdown(dedent(child), context, true)}</span>` : '';
      count++;
      return element(child, context, depth + 1);
    }).join('') : children(node.children, context, true, depth);
    const inner = content.replace(/^<p>([\s\S]*)<\/p>\n?$/, '$1');
    if (name === 'link') {
      const state = getState(name), target = a.url ?? a.href ?? state.url;
      const url = typeof target === 'string' && target.startsWith('sandbox:/') ? target : safeRemoteURL(target);
      return url ? `<a href="${esc(url)}">${inner || esc(a.title ?? state.title ?? url)}</a>` : inner || esc(a.title ?? state.title);
    }
    if (name === 'bold' || name === 'italic' || name === 'badge') { const tag = name === 'bold' ? 'strong' : name === 'italic' ? 'em' : 'span'; return `<${tag} class="dil-${name}"${presentation}>${inner}</${tag}>`; }
    if (name === 'title') return `<h3 class="dil-title"${presentation}>${inner}</h3>`;
    if (name === 'text' || name === 'caption') return `<div class="dil-${name}"${presentation}>${content}</div>`;
    if (name === 'table') return `<div class="dil-table-wrap"><table>${content}</table></div>`;
    const table: Record<string, string> = { 'table-head': 'thead', 'table-body': 'tbody', 'table-row': 'tr', 'table-cell': a.header ? 'th' : 'td', list: 'ul', 'list-item': 'li' };
    if (table[name]) return `<${table[name]}>${content}</${table[name]}>`;
    if (name === 'slider' || name === 'checkbox') {
      const handler = isDilFunction(a.onChange) ? a.onChange : undefined;
      const control = live.handlers.push(handler) - 1;
      const binding = ` data-dil-control="${control}"`;
      const label = esc(a.label ?? (name === 'slider' ? '调整数值' : '勾选项目'));
      if (name === 'checkbox') return `<label class="dil-checkbox"><input type="checkbox"${binding}${a.checked === true ? ' checked' : ''}><span>${inner || label}</span></label>`;
      const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
      const min = finite(a.min, 0), max = Math.max(min, finite(a.max, 100));
      return `<input class="dil-slider" type="range" min="${min}" max="${max}" step="${Math.max(.0001, finite(a.step, 1))}" value="${Math.max(min, Math.min(max, finite(a.value, min)))}" aria-label="${label}"${binding}>`;
    }
    if (name === 'label') return `<label class="dil-label">${inner}</label>`;
    if (name === 'input' || name === 'select' || name === 'button') {
      const handler = name === 'button' ? a.onClick : a.onChange;
      const binding = ` data-dil-control="${live.handlers.push(isDilFunction(handler) ? handler : undefined) - 1}"`;
      const disabled = a.disabled === true ? ' disabled' : '';
      const label = a.label ? ` aria-label="${esc(a.label)}"` : '';
      if (name === 'input') return `<input type="text" class="dil-input" value="${esc(a.value ?? a.defaultValue)}" placeholder="${esc(a.placeholder)}"${label}${binding}${disabled}>`;
      if (name === 'button') return `<button type="button" class="dil-button${a.block ? ' dil-block' : ''}${a.variant === 'outline' ? ' dil-button-outline' : ''}"${label}${binding}${disabled}>${inner || esc(a.label || '按钮')}</button><span class="dil-copy-status" role="status" aria-live="polite"></span>`;
      const options = Array.isArray(a.options) ? a.options.slice(0, 1000).map(value => {
        const option = data(value), key = text(option.value ?? value), label = text(option.label ?? value);
        return `<option value="${esc(key)}"${key === text(a.value) ? ' selected' : ''}>${esc(label)}</option>`;
      }).join('') : content;
      if (a.options !== undefined && !Array.isArray(a.options)) limited = true;
      return `<select class="dil-select"${label}${binding}${disabled}>${options}</select>`;
    }
    if (name === 'option') return `<option value="${esc(a.value)}">${inner}</option>`;
    if (name === 'radio' || name === 'progress') {
      limited = true;
      return `<div class="dil-static-control">${content || esc(a.label ?? a.placeholder ?? name)}${a.value !== undefined ? ` <span>${esc(a.value)}</span>` : ''}<small>存档快照</small></div>`;
    }
    if (name === 'appblock' || singles.has(name)) {
      limited = true; return `<div class="dil-static-control">${esc(a.title ?? name)}${content}<small>请在原始内容中查看完整组件</small></div>`;
    }
    const classes = ['dil-layout', 'dil-' + name];
    if (compactRow) classes.push('dil-row-inline');
    if (a.border) classes.push('dil-bordered');
    if (a.background) classes.push('dil-surface');
    if (a.flex) classes.push('dil-flex');
    if (name === 'grid') classes.push('dil-cols-' + Math.max(1, Math.min(4, Number(a.columns) || 2)));
    if (a.padding) classes.push('dil-padded');
    const layout = Object.fromEntries(['background','radius','padding','gap','flex','align','justify','width','height','clip'].filter(key=>a[key] !== undefined).map(key=>[key,a[key]]));
    return `<div class="${classes.join(' ')}" data-dil-layout="${esc(JSON.stringify(layout))}">${content}</div>`;
  }
  const rendered = children(tree, scope, false);
  const note = limited ? '<div class="dil-note">部分交互或表达式以存档快照展示。</div>' : '';
  const interactive = !runtime && live.handlers.length ? ` data-dil-interactive="${esc(encodeURIComponent(JSON.stringify({ body: original || dil?.fallbackMarkdown || '', ui, chatGPT, imageAssets, fileAssets })))}"` : '';
  return sanitize(`<div class="dil-response"${interactive}>${rendered}</div>${note}<details class="dil-source"><summary>${limited?'查看布局标记与未还原内容':'查看布局标记（正文已展示）'}</summary><pre><code>${esc(original || dil?.fallbackMarkdown || '')}</code></pre></details>`);
}

// Preserve existing nodes (especially a dragged range input) while updating
// computed text and attributes. Interaction is local to this archived reply.
function updateDilDOM(target: Node, source: Node, childrenOnly = false, previous?: Node): void {
  if (previous?.isEqualNode(source)) return;
  if (!childrenOnly && target instanceof Element && source instanceof Element) {
    for (const attr of Array.from(target.attributes)) if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    for (const attr of Array.from(source.attributes)) if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
    if (target instanceof HTMLInputElement && source instanceof HTMLInputElement) { target.value = source.value; target.checked = source.checked; }
  }
  const old = Array.from(target.childNodes), next = Array.from(source.childNodes);
  for (let i = 0; i < Math.max(old.length, next.length); i++) {
    if (!next[i]) old[i].remove();
    else if (!old[i]) target.appendChild(next[i].cloneNode(true));
    else if (old[i].nodeType !== next[i].nodeType || old[i].nodeName !== next[i].nodeName) target.replaceChild(next[i].cloneNode(true), old[i]);
    else if (old[i].nodeType === Node.TEXT_NODE) { if (old[i].textContent !== next[i].textContent) old[i].textContent = next[i].textContent; }
    else updateDilDOM(old[i], next[i], false, previous?.childNodes[i]);
  }
}
let dilFieldId = 0;
const hydratedDil = new WeakSet<HTMLElement>();
const dilCompositionBound = new WeakSet<HTMLInputElement>();
function decorateDilControls(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-dil-interactive]').forEach(response => {
    if (hydratedDil.has(response)) return;
    hydratedDil.add(response);
    let config: { body: string; ui?: ChatGPTUI; chatGPT: boolean; imageAssets: Record<string,string>; fileAssets: FileAssets };
    try { config = JSON.parse(decodeURIComponent(response.dataset.dilInteractive!)); } catch { return; }
    const runtime: DilRuntime = { states: Object.create(null), handlers: [] };
    const render = () => renderMessageContent(config.body, config.ui, config.chatGPT, config.imageAssets, config.fileAssets, runtime);
    const initial = document.createElement('template'); initial.innerHTML = render();
    let previous = initial.content.querySelector('.dil-response')!;
    const bind = () => response.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-dil-control]').forEach(input => {
      const fieldLabel = input.parentElement?.querySelector<HTMLLabelElement>(':scope > .dil-label');
      if (fieldLabel) {
        if (!input.id) input.id = `dil-field-${++dilFieldId}`;
        fieldLabel.htmlFor = input.id;
      }
      if (input.type === 'range' && input.getAttribute('aria-label') === '调整数值') {
        const label = input.parentElement?.querySelector('.dil-row .dil-text')?.textContent?.trim();
        if (label) input.setAttribute('aria-label', label);
      }
      const change = () => {
        const handler = runtime.handlers[Number(input.dataset.dilControl)];
        if (!isDilFunction(handler)) return;
        let copied: string | undefined;
        runtime.copy = value => { copied = value; };
        try { callDil(handler, input instanceof HTMLButtonElement ? [] : [input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) : input.value]); }
        finally { runtime.copy = undefined; }
        if (copied !== undefined && input instanceof HTMLButtonElement) {
          const status = input.nextElementSibling as HTMLElement;
          status.textContent = '';
          navigator.clipboard.writeText(copied).then(() => { status.textContent = '已复制'; }).catch(() => { status.textContent = '复制失败，请重试'; });
          setTimeout(() => { status.textContent = ''; }, 2500);
        }
        const template = document.createElement('template'); template.innerHTML = render();
        const next = template.content.querySelector('.dil-response');
        if (!next) return;
        // Keep the hydration marker on the root; patch only its children.
        updateDilDOM(response, next, true, previous); previous = next;
        decorateMessageImages(response); bind();
      };
      if (input instanceof HTMLButtonElement) input.onclick = change;
      else if (input instanceof HTMLInputElement && input.type !== 'checkbox') {
        input.oninput = event => { if (!(event as InputEvent).isComposing) change(); };
        if (!dilCompositionBound.has(input)) {
          dilCompositionBound.add(input);
          input.addEventListener('compositionend', () => input.dispatchEvent(new Event('input', {bubbles: true})));
        }
      }
      else input.onchange = change;
    });
    bind();
  });
}

export function decorateMessageImages(root: ParentNode): void {
  decorateMermaidDiagrams(root);
  decorateDilControls(root);
  root.querySelectorAll<HTMLElement>('.dil-local-image').forEach(node => {
    const id = node.dataset.assetId;
    if (!id || !/^[a-f0-9]{64}$/.test(id) || node.querySelector('img')) return;
    const image = document.createElement('img'), link = document.createElement('a');
    image.alt = node.dataset.imageAlt || '回答中的图片'; image.loading = 'lazy';
    link.href = image.src = '/api/assets/' + id; link.target = '_blank'; link.rel = 'noopener';
    image.onerror = () => { node.textContent = '本地图片读取失败，可重新同步补充'; };
    link.append(image); node.replaceChildren(link);
  });
  // Apply only validated CSS values after sanitization. Archived CSS, scripts,
  // event handlers and compiled component code are never evaluated.
  root.querySelectorAll<HTMLElement>('[data-dil-layout],[data-dil-presentation]').forEach(node=>{
    let a: Data;
    try { a = data(JSON.parse(node.dataset.dilLayout ?? node.dataset.dilPresentation ?? '{}')); } catch { return; }
    const scale=(value: unknown)=>typeof value==='number' && Number.isFinite(value) && value>=0 && value<=16 ? `${value*4}px` : undefined;
    const length=(value: unknown)=>typeof value==='string' && /^(?:\d{1,3}(?:\.\d+)?(?:px|%)|auto)$/.test(value) ? value : undefined;
    for(const key of ['padding','gap'] as const) { const value=scale(a[key]); if(value)node.style[key]=value; }
    if(a.padding && typeof a.padding==='object' && !Array.isArray(a.padding)) {
      node.style.padding='0';
      const sides=data(a.padding);
      for(const side of ['top','right','bottom','left'] as const) { const value=scale(sides[side]); if(value)node.style.setProperty('padding-'+side,value); }
    }
    for(const key of ['width','height'] as const) { const value=length(a[key]); if(value)node.style[key]=value; }
    const radius=({sm:'4px',md:'6px',lg:'10px',xl:'14px',full:'9999px'} as Record<string,string>)[text(a.radius)];
    if(radius)node.style.borderRadius=radius;
    if(typeof a.flex==='number' && Number.isFinite(a.flex) && a.flex>0 && a.flex<=16)node.style.flex=`${a.flex} 1 0%`;
    const align=({center:'center',start:'flex-start',end:'flex-end',stretch:'stretch'} as Record<string,string>)[text(a.align)];
    if(align)node.style.alignItems=align;
    const justify=({center:'center',start:'flex-start',end:'flex-end',between:'space-between',around:'space-around'} as Record<string,string>)[text(a.justify)];
    if(justify)node.style.justifyContent=justify;
    const background=text(a.background);
    if(['surface-secondary','surface-tertiary'].includes(background))node.style.backgroundColor='var(--hover)';
    else if(/^#[\da-f]{3,8}$/i.test(background) || /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/i.test(background))node.style.backgroundColor=background;
    if(a.clip===true)node.style.overflow='hidden';
    if(a.height!==undefined) { node.style.flexShrink='0'; if(!node.textContent?.trim())node.style.minHeight='0'; }
    if(a.color==='secondary')node.style.color='var(--muted)';
    if(/^#[\da-f]{3,8}$/i.test(text(a.color)))node.style.color=text(a.color);
    if(['success','info','warning','danger'].includes(text(a.color)))node.classList.add('dil-'+a.color);
    const size=({'2xs':'.75em',xs:'.85em',sm:'.93em',lg:'1.2em',xl:'1.5em','2xl':'1.85em'} as Record<string,string>)[text(a.size)];
    if(size)node.style.fontSize=node.classList.contains('dil-inline') ? `calc(var(--read-size) * ${parseFloat(size)})` : size;
    if(a.weight==='medium')node.style.fontWeight='600';
    if(a.tabularNums===true)node.style.fontVariantNumeric='tabular-nums';
  });
  root.querySelectorAll<HTMLButtonElement>('.dil-load-image').forEach(button => {
    button.onclick = () => {
      const url = safeRemoteURL(button.dataset.imageUrl);
      if (!url) return;
      const image = document.createElement('img');
      image.alt = button.dataset.imageAlt || '回答中的图片'; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.onload = () => button.remove();
      image.onerror = () => { image.remove(); button.disabled = false; button.textContent = '图片加载失败，点击重试'; };
      button.disabled = true; button.textContent = '正在加载…'; button.parentElement!.append(image); image.src = url;
    };
  });
}
