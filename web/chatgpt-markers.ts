import { markdownLiteralEnd } from './math';
import type { ChatGPTUI } from './message-content';

type Data = Record<string, unknown>;
const data = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const esc = (value: unknown) => text(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const list = (value: unknown): Data[] => Array.isArray(value) ? value.map(data) : [];
function remoteURL(value: unknown): string | undefined {
  try { const url = new URL(text(value)); if (/^https?:$/.test(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Missing or invalid archived URL. */ }
}
function refID(value: unknown): string {
  const ref = data(value);
  return text(value) || (ref.turn_index !== undefined ? `turn${text(ref.turn_index)}${text(ref.ref_type)}${text(ref.ref_index)}` : '');
}

const colors = ['#3c86d1', '#209969', '#d9952b', '#9664cf', '#d16c7d', '#478d98'];
function chartHTML(chart: Data): string | undefined {
  const rows = list(chart.data), meta = data(chart.meta), series = list(chart.series);
  const category = text(chart.nameKey ?? chart.xKey), valueKey = text(chart.valueKey ?? series[0]?.dataKey);
  if (!rows.length || rows.length > 200 || !category || !valueKey) return;
  const columns = series.length ? series : [{ dataKey: valueKey, label: valueKey }];
  if (columns.length > 20) return;
  const format = (row: Data, column: Data) => `${text(column.valuePrefix)}${text(row[text(column.dataKey)])}${text(column.valueSuffix)}`;
  // Keep exact values accessible and searchable even when a chart type is not
  // supported. All visuals are generated locally from data, never archived JS.
  const table = `<div class="dil-table-wrap"><table><thead><tr><th>类别</th>${columns.map(col => `<th>${esc(col.label ?? col.dataKey)}</th>`).join('')}</tr></thead><tbody>${rows.map((row, i) => `<tr><th scope="row">${chart.chartType === 'pie' ? `<svg class="genui-swatch" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="${colors[i % colors.length]}"/></svg>` : ''}${esc(row[category])}</th>${columns.map(col => `<td>${esc(format(row, col))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const values = rows.map(row => row[valueKey]);
  const numeric = values.every((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  let visual = '';
  const total = numeric ? (values as number[]).reduce((sum, value) => sum + value, 0) : 0;
  if (chart.chartType === 'pie' && numeric && total > 0 && Number.isFinite(total)) {
    let angle = -Math.PI / 2;
    const slices = (values as number[]).map((value, i) => {
      const start = angle, fraction = value / total;
      angle += fraction * Math.PI * 2;
      const label = esc(`${text(rows[i][category])}：${format(rows[i], columns[0])}（${(fraction * 100).toFixed(1)}%）`);
      if (!value) return '';
      if (fraction === 1) return `<circle cx="100" cy="100" r="90" fill="${colors[i % colors.length]}"><title>${label}</title></circle>`;
      return `<path d="M100 100 L${100 + 90 * Math.cos(start)} ${100 + 90 * Math.sin(start)} A90 90 0 ${fraction > .5 ? 1 : 0} 1 ${100 + 90 * Math.cos(angle)} ${100 + 90 * Math.sin(angle)} Z" fill="${colors[i % colors.length]}"><title>${label}</title></path>`;
    }).join('');
    visual = `<svg class="genui-pie" viewBox="0 0 200 200" role="img" aria-label="${esc(meta.title ?? '饼图')}">${slices}</svg>`;
  } else if (chart.chartType === 'bar' && columns.length === 1 && numeric) {
    const max = Math.max(...values as number[]);
    visual = `<svg class="genui-bars" viewBox="0 0 640 ${rows.length * 36 + 8}" role="img" aria-label="${esc(meta.title ?? '条形图')}">${rows.map((row, i) => `<text x="100" y="${i * 36 + 24}" text-anchor="end" fill="currentColor" font-size="13">${esc(row[category])}</text><rect x="112" y="${i * 36 + 8}" width="${max ? (values[i] as number) / max * 340 : 0}" height="23" rx="3" fill="${colors[0]}"><title>${esc(format(row, columns[0]))}</title></rect><text x="${120 + (max ? (values[i] as number) / max * 340 : 0)}" y="${i * 36 + 24}" fill="currentColor" font-size="12">${esc(format(row, columns[0]))}</text>`).join('')}</svg>`;
  }
  return `<figure class="genui-chart"><figcaption><strong>${esc(meta.title ?? '数据图表')}</strong>${meta.description ? `<p>${esc(meta.description)}</p>` : ''}</figcaption>${visual}${table}${meta.footer ? `<p class="genui-footer">${esc(meta.footer)}</p>` : ''}</figure>`;
}

// Process only ChatGPT prose, consuming a whole marker before inspecting its
// JSON. Code fences, inline code and TeX remain opaque to this parser.
export function renderChatGPTMarkers(body: string, ui: ChatGPTUI | undefined, slot: (html: string, block: boolean) => string): string {
  if (!/\uE200(?:cite|genui)\uE202/.test(body)) return body;
  const references = ui?.content_references ?? [], numbers = new Map<string, number>();
  function citation(raw: string, payload: string): string {
    const ids = payload.split('\uE202');
    const exact = references.filter(ref => ref.matched_text === raw);
    const sources: Data[] = [];
    for (const ref of exact) {
      const items = list(ref.items).length ? list(ref.items) : list(ref.fallback_items);
      sources.push(...items);
      if (!items.length && Array.isArray(ref.safe_urls)) sources.push(...ref.safe_urls.map(url => ({ url })));
    }
    if (!exact.length) {
      for (const ref of references) for (const item of list(ref.items)) {
        if (Array.isArray(item.refs) && item.refs.some(value => ids.includes(refID(value)))) sources.push(item);
      }
      for (const group of ui?.search_result_groups ?? []) for (const item of list(group.entries ?? group.search_results)) {
        if (ids.includes(refID(item.ref_id ?? item.ref))) sources.push(item);
      }
    }
    const links = new Map<string, string>();
    for (const source of sources) {
      const url = remoteURL(source.url);
      if (!url || links.has(url)) continue;
      if (!numbers.has(url)) numbers.set(url, numbers.size + 1);
      links.set(url, `<a href="${esc(url)}" title="${esc(source.title ?? source.attribution ?? '来源')}">[${numbers.get(url)}]</a>`);
    }
    return `<span class="dil-citations">${links.size ? [...links.values()].join(' ') : '<span title="引用网址未包含在存档中">[来源未归档]</span>'}</span>`;
  }
  let result = '';
  for (let i = 0; i < body.length;) {
    const end = markdownLiteralEnd(body, i);
    if (end > i) { result += body.slice(i, end); i = end; continue; }
    if (body[i] === '\\' && i + 1 < body.length) { result += body.slice(i, i + 2); i += 2; continue; }
    const match = body[i] === '\uE200' && /^\uE200(cite|genui)\uE202([\s\S]*?)\uE201/.exec(body.slice(i));
    if (!match) { result += body[i++]; continue; }
    const [raw, kind, payload] = match;
    if (kind === 'cite') result += slot(citation(raw, payload), false);
    else {
      let chart: Data = {};
      try { chart = data(data(JSON.parse(payload)).chart); } catch { /* Try resolved widget data below. */ }
      let html = chartHTML(chart);
      if (!html) {
        const ref = references.find(ref => ref.matched_text === raw && data(ref.data).widget_type === 'charts_widget_v2');
        html = chartHTML(data(data(ref?.data).content));
      }
      result += slot(html ?? `<details class="genui-fallback"><summary>图表暂无法还原，查看原始内容</summary><pre><code>${esc(raw)}</code></pre></details>`, true);
    }
    i += raw.length;
  }
  return result;
}
