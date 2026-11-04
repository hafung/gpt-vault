import { test, expect } from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const session = { id: 'dil-fixture', title: 'Intelligent UI 归档', project: 'ChatGPT', cwd: '', provider: 'ChatGPT', platform: 'Windows', model: 'GPT', favorite: 0, message_count: 1, total_count: 1, created: 1767225600, updated: 1767225600 };

async function fixture(page: import('@playwright/test').Page, body: string, metadata = {}, truncated = false, expanded = body) {
  await page.route('**/*', async route=>{
    const url=new URL(route.request().url());
    if(route.request().resourceType()==='document')return route.fulfill({body:await readFile(resolve('dist/index.html')),contentType:'text/html'});
    if(url.pathname.startsWith('/assets/'))return route.fulfill({body:await readFile(resolve('dist',url.pathname.slice(1))),contentType:url.pathname.endsWith('.js')?'application/javascript':'text/css'});
    return route.fallback();
  });
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/assets/')) return route.fulfill({contentType:'image/png', body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=', 'base64')});
    if (path === '/api/stats') return route.fulfill({ json: { sessions: 1, messages: 1, events: 1, projects: 1, favorites: 0, projects_list: [], platforms: [], providers: [], last_sync: 1, db_bytes: 0, raw_bytes: 0 } });
    if (path === '/api/messages/1') return route.fulfill({ json: { body: expanded } });
    if (path === '/api/sessions/dil-fixture') return route.fulfill({ json: { session, offset: 0, total: 1, more: false, items: [{ id: 1, role: 'assistant', kind: 'message', phase: '', timestamp: session.created, body, metadata, truncated, length: 25000 }] } });
    if (path === '/api/sessions') return route.fulfill({ json: { items: [], more: false, offset: 0, elapsed_ms: 0 } });
    if (path === '/api/sync') return route.fulfill({ json: { running: false, started: 1, finished: 1, errors: [], warnings: [], done: 0, total: 0, imported: 0, skipped: 0 } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/?session=dil-fixture');
  await expect(page.locator('.message')).toBeVisible();
}

const marker = (kind: string, payload: string) => `\uE200${kind}\uE202${payload}\uE201`;
test('writing dialogue and bilingual document render as titled blocks and copy separately after expansion', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text; } } });
  });
  const dialogue = '**Dad:** Hey, what are you working on over there?  \n**Daughter:** I’m making a little house out of cardboard.  \n**Dad:** Keep at it.';
  const body = `前文 **保留**。\n\n:::writing{variant="chat_message" id="58314" title="Dad & Daughter Dialogue"}\n${dialogue}\n:::\n\n后文说明。\n\n:::writing{variant="document" id="58314" title="中英对照"}\n**Dad:** Keep at it.  \n**爸爸：** 继续做下去吧。\n\n第二段。\n:::\n\n最后一句。`;
  await fixture(page, body, {}, true, body + '\n\n完整内容。');
  for (const expanded of [false, true]) {
    if (expanded) await page.locator('.expand-message').click();
    const blocks = page.locator('.chatgpt-writing');
    await expect(blocks).toHaveCount(2);
    await expect(blocks.locator('.chatgpt-writing-header > strong')).toHaveText(['Dad & Daughter Dialogue', '中英对照']);
    await expect(blocks.first().locator('.chatgpt-writing-body strong')).toHaveText(['Dad:', 'Daughter:', 'Dad:']);
    await expect(blocks.nth(1).locator('.chatgpt-writing-body p')).toHaveCount(2);
    await expect(page.locator('.prose')).toContainText('前文 保留。');
    await expect(page.locator('.prose')).toContainText('后文说明。');
    await expect(page.locator('.prose')).toContainText('最后一句。');
    await expect(page.locator('.prose')).not.toContainText(':::writing');
    await blocks.first().getByRole('button', { name: '复制写作内容' }).click();
    expect(await page.evaluate(() => (window as unknown as { copied: string }).copied)).toBe('Dad: Hey, what are you working on over there?\nDaughter: I’m making a little house out of cardboard.\nDad: Keep at it.');
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
});

test('writing wrappers coexist with nested DIL, citations, TeX and code containing closing delimiters', async ({ page }) => {
  const cite = marker('cite', 'turn1view0');
  const body = `<box>\n\n:::writing{variant="document" id="12" title="带格式的写作"}\n# 正文标题\n\n${cite}\n\n\\(x^2\\)\n\n\`\`\`text\n:::\n\`\`\`\n\n<text>组件正文</text>\n:::\n\n写作块后的 **正文**。\n</box>`;
  await fixture(page, body, { chatgpt_ui: { content_references: [{ matched_text: cite, items: [{ url: 'https://example.com/writing-source' }] }] } });
  const block = page.locator('.dil-response .chatgpt-writing');
  await expect(block).toHaveCount(1);
  await expect(block.locator('h1')).toHaveText('正文标题');
  await expect(block.locator('.dil-citations a')).toHaveAttribute('href', 'https://example.com/writing-source');
  await expect(block.locator('math')).toHaveCount(1);
  await expect(block.locator('pre code')).toHaveText(':::\n');
  await expect(block.locator('.dil-text')).toHaveText('组件正文');
  await expect(block).not.toContainText('写作块后的');
  await expect(page.locator('.dil-response')).toContainText('写作块后的 正文。');
});

test('writing examples in code and incomplete or invalid directives stay literal', async ({ page }) => {
  const writing = ':::writing{variant="document" id="12" title="示例"}\n内容\n:::';
  const incomplete = ':::writing{variant="document" id="13" title="未结束"}\n后续正文仍保留。';
  await fixture(page, `\`\`\`\`text\n${writing}\n\`\`\`\n\`\`\`\`\n\n\`${writing.split('\n')[0]}\`\n\n:::writing{variant={run()} id="14"}\n普通内容\n:::\n\n${incomplete}`);
  await expect(page.locator('.chatgpt-writing')).toHaveCount(0);
  await expect(page.locator('.prose pre code')).toHaveText(writing + '\n```\n');
  await expect(page.locator('.prose p code')).toHaveText(writing.split('\n')[0]);
  await expect(page.locator('.prose')).toContainText('variant={run()}');
  await expect(page.locator('.prose')).toContainText('后续正文仍保留。');
});

test('writing titles and content pass through sanitization without executing markup', async ({ page }) => {
  const title = '<img src=x onerror=window.xss=1> & title';
  await fixture(page, `:::writing{variant="document" id="15" title=${JSON.stringify(title)}}\n<script>window.xss=1</script>\n\n保留 **正文**。\n\n[危险链接](javascript:alert(1))\n:::\n\n块外正文。`);
  await expect(page.locator('.chatgpt-writing-header > strong')).toHaveText(title);
  await expect(page.locator('.chatgpt-writing-body strong')).toHaveText('正文');
  await expect(page.locator('.prose img,.prose script,.prose [onerror],.prose a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator('.chatgpt-writing')).not.toContainText('块外正文');
  expect(await page.evaluate(() => 'xss' in window)).toBeFalsy();
});

test('archived hidden memcite disappears from prose while citations, DIL and literal examples survive expansion', async ({ page }) => {
  const memory = '\uE200memcite\uE201', cite = marker('cite', 'turn1search0');
  const body = `<box>\n\n**继续 PG。** ${cite} ${memory}\n\n</box>\n\n\`${memory}\`\n\n\`\`\`text\n${memory}\n\`\`\``;
  await fixture(page, body, { chatgpt_ui: { content_references: [
    { type: 'hidden', matched_text: memory, refs: [], safe_urls: [] },
    { type: 'grouped_webpages', matched_text: cite, items: [{ url: 'https://example.com/database', title: '数据库来源' }] },
  ] } }, true, body + '\n\n完整内容。');
  for (const expanded of [false, true]) {
    if (expanded) await page.locator('.expand-message').click();
    await expect(page.locator('.dil-response strong')).toHaveText('继续 PG。');
    await expect(page.locator('.dil-response .dil-box')).not.toContainText(memory);
    await expect(page.locator('.dil-citations a')).toHaveAttribute('href', 'https://example.com/database');
    await expect(page.locator('.dil-response p code')).toHaveText(memory);
    await expect(page.locator('.dil-response pre code')).toHaveText(memory + '\n');
  }
});

test('hidden memcite also disappears from plain Markdown without changing its formatting', async ({ page }) => {
  const memory = '\uE200memcite\uE201';
  await fixture(page, `**继续 PG。** ${memory}`, { chatgpt_ui: { content_references: [{ type: 'hidden', matched_text: memory }] } });
  await expect(page.locator('.prose strong')).toHaveText('继续 PG。');
  await expect(page.locator('.prose')).not.toContainText(memory);
});

test('memcite without an exact hidden reference stays intact', async ({ page }) => {
  const memory = '\uE200memcite\uE201';
  await fixture(page, `正文 ${memory}`, { chatgpt_ui: { content_references: [
    { type: 'hidden', matched_text: memory + '其他正文' },
    { type: 'grouped_webpages', matched_text: memory },
  ] } });
  await expect(page.locator('.prose')).toContainText(`正文 ${memory}`);
});

const industryChart = {
  chartType: 'pie', meta: { title: '2025 年中国 GDP 三次产业结构', description: 'GDP 140.19 万亿元，按三次产业增加值划分。', footer: '数据：国家统计局，2025 年国民经济和社会发展统计公报' },
  nameKey: 'industry', valueKey: 'gdp', series: [{ dataKey: 'gdp', label: '增加值', valueFormat: 'raw', valueSuffix: ' 万亿元' }],
  data: [{ industry: '第一产业', gdp: 9.33 }, { industry: '第二产业', gdp: 49.97 }, { industry: '第三产业', gdp: 80.89 }],
};

test('industry overview renders genui pie data and citations using archived matched_text', async ({ page }) => {
  const cite = marker('cite', 'turn121943view0'), other = marker('cite', 'turn121943view1');
  const chart = marker('genui', JSON.stringify({ chart: industryChart }));
  const url = 'https://www.stats.gov.cn/sj/zxfb/202602/t20260228_1962662.html';
  const metadata = { chatgpt_ui: { content_references: [
    // Archived turn indexes differ from the opaque IDs in the answer.
    { matched_text: cite, type: 'grouped_webpages', items: [{ url, title: '国家统计局公报', refs: [{ turn_index: 2, ref_type: 'view', ref_index: 0 }] }] },
    { matched_text: other, type: 'grouped_webpages', items: [{ url, title: '国家统计局公报', refs: [{ turn_index: 2, ref_type: 'view', ref_index: 1 }] }] },
  ] } };
  const body = `# 中国行业数据总览\n\n三次产业。${cite}\n\n${chart}\n\n后续 **行业正文**。${other}\n\n| 指标 | 来源 |\n|---|---|\n| GDP | ${cite} |`;
  await fixture(page, body, metadata, true, body + '\n\n完整内容。');
  for (const expanded of [false, true]) {
    if (expanded) await page.locator('.expand-message').click();
    await expect(page.locator('.genui-chart')).toHaveCount(1);
    await expect(page.locator('.genui-pie path')).toHaveCount(3);
    await expect(page.locator('.genui-swatch circle')).toHaveCount(3);
    for (let i = 0; i < 3; i++) expect(await page.locator('.genui-swatch circle').nth(i).getAttribute('fill')).toBe(await page.locator('.genui-pie path').nth(i).getAttribute('fill'));
    await expect(page.locator('.genui-chart tbody tr')).toHaveCount(3);
    await expect(page.locator('.genui-chart td')).toHaveText(['9.33 万亿元', '49.97 万亿元', '80.89 万亿元']);
    await expect(page.locator('.genui-chart figcaption')).toContainText(industryChart.meta.description);
    await expect(page.locator('.genui-footer')).toHaveText(industryChart.meta.footer);
    await expect(page.locator('.dil-citations a')).toHaveCount(3);
    for (const link of await page.locator('.dil-citations a').all()) {
      await expect(link).toHaveAttribute('href', url);
      await expect(link).toHaveText('[1]');
    }
    await expect(page.locator('.prose > table td .dil-citations a')).toHaveCount(1);
    await expect(page.locator('.prose strong').filter({ hasText: '行业正文' })).toHaveCount(1);
    await expect(page.locator('.prose')).not.toContainText('\uE200');
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
});

test('genui bar charts coexist with nested DIL, image groups, TeX and literal code', async ({ page }) => {
  const chart = marker('genui', JSON.stringify({ chart: {
    chartType: 'bar', layout: 'vertical', xKey: 'partner', meta: { title: '2025 年中国主要贸易伙伴' },
    series: [{ dataKey: 'trade', label: '贸易额', valueSuffix: ' 万亿元' }],
    data: [{ partner: '东盟', trade: 7.546 }, { partner: '欧盟', trade: 5.925 }, { partner: '美国', trade: 4.007 }],
  } }));
  const cite = marker('cite', 'turn1view0'), image = marker('image_group', '{"image_refs":[]}');
  await fixture(page, `<box>\n正文 ${cite}\n\n${chart}\n\n${image}\n\n\\(x^2\\)\n</box>\n\n\`\`\`text\n${chart}\n${cite}\n\`\`\`\n\n\`${cite}\``, {
    chatgpt_ui: { search_result_groups: [{ entries: [{ ref_id: { turn_index: 1, ref_type: 'view', ref_index: 0 }, url: 'https://example.com/source' }] }] },
  });
  await expect(page.locator('.dil-response .genui-bars rect')).toHaveCount(3);
  await expect(page.locator('.genui-chart td')).toHaveText(['7.546 万亿元', '5.925 万亿元', '4.007 万亿元']);
  const bars = page.locator('.genui-bars rect');
  expect(Number(await bars.nth(0).getAttribute('width'))).toBeGreaterThan(Number(await bars.nth(1).getAttribute('width')));
  await expect(page.locator('.dil-citations a')).toHaveAttribute('href', 'https://example.com/source');
  await expect(page.locator('.chatgpt-image-group')).toHaveCount(1);
  await expect(page.locator('.dil-response math')).toHaveCount(1);
  await expect(page.locator('.dil-response pre code')).toHaveText(`${chart}\n${cite}\n`);
  await expect(page.locator('.dil-response p code')).toHaveText(cite);
  await expect(page.locator('.dil-note')).toHaveCount(0);
});

test('missing or hostile genui and citation data preserve content without executing markup', async ({ page }) => {
  const bad = marker('genui', '{broken'), unknown = marker('genui', '{"widget":"unknown"}');
  const hostile = marker('genui', JSON.stringify({ chart: { ...industryChart, meta: { title: '<img src=x onerror="window.xss=1">' }, data: [{ industry: '<script>window.xss=1</script>', gdp: 1 }] } }));
  const cite = marker('cite', 'turnMissingview0');
  await fixture(page, `${bad}\n\n${unknown}\n\n${hostile}\n\n末尾 **保留**。${cite}`, {
    chatgpt_ui: { content_references: [{ matched_text: cite, items: [{ url: 'javascript:alert(1)', title: '危险' }] }] },
  });
  await expect(page.locator('.genui-fallback')).toHaveCount(2);
  await expect(page.locator('.genui-fallback pre code')).toHaveText([bad, unknown]);
  await expect(page.locator('.genui-pie circle')).toHaveCount(1);
  await expect(page.locator('.genui-chart figcaption')).toHaveText('<img src=x onerror="window.xss=1">');
  await expect(page.locator('.prose')).toContainText('末尾 保留');
  await expect(page.locator('.dil-citations')).toHaveText('[来源未归档]');
  await expect(page.locator('.prose img,.prose script,.prose [onerror],.prose a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => 'xss' in window)).toBeFalsy();
});

test('resolved widget metadata restores missing chart payloads and unsupported visuals retain exact data', async ({ page }) => {
  const resolved = marker('genui', '{"chart":{"id":"resolved"}}');
  const unsupported = marker('genui', JSON.stringify({ chart: { ...industryChart, chartType: 'future-chart' } }));
  await fixture(page, `${resolved}\n\n${unsupported}\n\n后续正文。`, { chatgpt_ui: { content_references: [
    { matched_text: resolved, type: 'client_defined_widget', data: { widget_type: 'charts_widget_v2', content: industryChart } },
  ] } });
  await expect(page.locator('.genui-chart')).toHaveCount(2);
  await expect(page.locator('.genui-pie')).toHaveCount(1);
  await expect(page.locator('.genui-chart').last().locator('td')).toHaveText(['9.33 万亿元', '49.97 万亿元', '80.89 万亿元']);
  await expect(page.locator('.genui-fallback')).toHaveCount(0);
  await expect(page.locator('.prose')).toContainText('后续正文。');
});

test('image-only GPT replies display archived generated pictures without expanding tools', async ({page}) => {
  const id = 'd'.repeat(64);
  await fixture(page, '', {source_role:'tool', assets:[id], image_assets:{'sediment://generated':id}});
  await expect(page.locator('.message.assistant .message-heading b')).toHaveText('GPT');
  await expect(page.locator('.message.assistant .image-link img')).toBeVisible();
  await expect.poll(()=>page.locator('.image-link img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(1);
  await expect(page.locator('.message .technical')).toHaveCount(0);
  await expect(page.locator('.attachment-reference')).toHaveCount(0);
});

test('sandbox Markdown downloads and storyboard pictures use archived bytes and readable names', async ({page}) => {
  const ref='sandbox:/workspace/scratch/珍珠奶茶_提示词.md', image='sandbox:/workspace/scratch/board.png';
  const docId='b'.repeat(64), imageId='c'.repeat(64);
  const body=`<box>\n\n[下载完整制作脚本（Markdown）](sandbox:/workspace/scratch/${encodeURIComponent('珍珠奶茶_提示词.md')})\n\n![分镜图](${image})\n\n<Link url="${ref}" title="完整脚本"/>\n\n[失效文件](sandbox:/mnt/data/expired.md)\n\n</box>`;
  await fixture(page,body,{assets:[docId,imageId],file_assets:{[ref]:{id:docId,name:'珍珠奶茶_提示词.md',mime:'text/plain'},[image]:{id:imageId,name:'board.png',mime:'image/png'}}},true,body+'\n\n完整内容');
  await expect(page.getByRole('link',{name:'下载完整制作脚本（Markdown）',exact:true})).toHaveAttribute('href','/api/assets/'+docId);
  await expect(page.getByRole('link',{name:'完整脚本',exact:true})).toHaveAttribute('href','/api/assets/'+docId);
  await expect(page.locator('a[download]').filter({hasText:'下载'}).first()).toHaveAttribute('download','珍珠奶茶_提示词.md');
  await expect(page.locator('.dil-local-image img')).toHaveAttribute('src','/api/assets/'+imageId);
  await expect(page.locator('.attachment-reference')).toContainText('文件尚未归档');
  await expect(page.locator('.image-link')).toHaveCount(0);
  await expect(page.locator('.local-path-link')).toHaveCount(0);
  await page.locator('.expand-message').click();
  await expect(page.getByRole('link',{name:'下载完整制作脚本（Markdown）',exact:true})).toHaveAttribute('href','/api/assets/'+docId);
  await expect(page.locator('.prose')).toContainText('完整内容');
});

test('nested DIL keeps prose, inline entities, links, citations, loops and tables', async ({ page }) => {
  const body = `# 推荐\n\n<box border padding={3}>\n  **第二选择：**\n\n  如果核心功能是声音克隆、AI 角色配音，特别是克隆声音之后还能控制人物的语气情绪，那么我甚至会反过来优先选它。\n\n  **<Entity value="声音平台"/>**，<Link url="https://example.com/voice" title="官方网站"/>。<Cite refs={["turn1search0"]}/>\n  <grid columns={2}>\n    {#each [{name:"声音克隆",desc:"角色配音"},{name:"情绪控制",desc:"语气调整"}] as item, i}\n      <grid-item>\n        <text>{item.name}</text>\n        <caption>{item.desc}</caption>\n      </grid-item>\n    {/each}\n  </grid>\n  <table><table-row><table-cell header>功能</table-cell><table-cell>保留内容</table-cell></table-row></table>\n</box>\n\n普通 **Markdown** 与 [外链](https://example.com)。\n\n\`\`\`xml\n<box>代码内的组件不应解析</box>\n\`\`\`\n\n行内代码 \`<Entity value="原样保留"/>\`。`;
  await fixture(page, body, { chatgpt_ui: { model_dil_v2: { appData: { opGenui: { componentResults: { cite: { componentName: 'Cite', state: { items: [{ url: 'https://example.com/source', title: '来源页面' }] } } } } } } } });
  const prose = page.locator('.dil-response');
  await expect(prose.locator('strong').filter({ hasText: '第二选择' })).toBeVisible();
  await expect(prose).toContainText('那么我甚至会反过来优先选它');
  await expect(prose.locator('.dil-entity')).toHaveText('声音平台');
  await expect(prose.locator('a[href="https://example.com/voice"]')).toHaveText('官方网站');
  await expect(prose.locator('.dil-citations a')).toHaveAttribute('href', 'https://example.com/source');
  await expect(prose.locator('.dil-grid-item')).toHaveCount(2);
  await expect(prose.locator('.dil-grid-item').last()).toContainText('语气调整');
  await expect(prose.locator('th')).toHaveText('功能');
  await expect(prose.locator('td')).toHaveText('保留内容');
  await expect(prose.locator('pre code')).toHaveText('<box>代码内的组件不应解析</box>\n');
  await expect(prose.locator('p code').last()).toHaveText('<Entity value="原样保留"/>');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('image_group renders archived pictures offline, keeps code literal and survives expansion', async ({ page }) => {
  const marker = '\uE200image_group\uE202'+JSON.stringify({layout:'carousel',image_refs:['turn345082image0','turn345082image2']})+'\uE201';
  const id = 'a'.repeat(64);
  let remoteRequests = 0;
  await page.route('https://images.example/**', route => { remoteRequests++; return route.abort(); });
  const metadata = {assets:[id], image_assets:{'https://images.example/first.png':id}, chatgpt_ui:{content_references:[{type:'image_group',matched_text:marker,images:[{image_result:{content_url:'https://images.example/first.png',title:'已归档图片',url:'https://example.com/source'}},{image_result:{content_url:'https://images.example/second.png',title:'待归档图片'}}]}]}};
  const body = `图片如下：\n\n${marker}\n\n说明 **保留**。\n\n\`\`\`text\n${marker}\n\`\`\``;
  await fixture(page,body,metadata,true,body+'\n\n完整内容。');
  await expect(page.locator('.chatgpt-image-group .dil-image')).toHaveCount(2);
  await expect(page.locator('.dil-local-image img')).toHaveAttribute('src','/api/assets/'+id);
  await expect.poll(()=>page.locator('.dil-local-image img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(1);
  await expect(page.locator('.image-link')).toHaveCount(0);
  await expect(page.locator('.dil-load-image')).toHaveCount(1);
  await expect(page.locator('.prose pre code')).toHaveText(marker+'\n');
  expect(remoteRequests).toBe(0);
  await page.locator('.expand-message').click();
  await expect(page.locator('.prose')).toContainText('完整内容');
  await expect(page.locator('.chatgpt-image-group .dil-image')).toHaveCount(2);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('missing and malformed image groups have readable fallbacks',async({page})=>{
  await fixture(page,'前文。\n\n\uE200image_group\uE202{"image_refs":["turn1image0"]}\uE201\n\n\uE200image_group\uE202broken\uE201\n\n后文。');
  await expect(page.locator('.prose')).toContainText('图片组的地址未包含在存档中');
  await expect(page.locator('.prose')).toContainText('图片组格式无法解析');
  await expect(page.locator('.prose')).toContainText('后文');
  await expect(page.locator('.prose')).not.toContainText('\uE200');
});

for (const nested of [false, true]) {
  test(`Markdown tables keep DIL text in its cell${nested ? ' inside a layout' : ''}`, async ({ page }) => {
    const table = `| 具体规定 | 风险判断 | 主要问题 |
|---|---|---|
| 绩效不合格，无补偿解除 | <text color="danger" weight="medium">高风险</text> | 不等于严重违纪 |
| 严重失职，造成损害 | <text color="warning" weight="medium">门槛模糊</text> | 需要明确损害程度 |
| 离职后持续保密 | <text color="secondary" weight="medium">原则上可合法</text> | 需要合理界定范围 |`;
    const content = `判断如下：\n\n${table}\n\n后续 **说明**。`;
    await fixture(page, nested ? `<box padding={3}>\n${content}\n</box>` : content,
      nested ? { chatgpt_ui: { model_dil_v2: {} } } : {});
    const prose = page.locator('.dil-response');
    const rendered = prose.locator('table');
    await expect(rendered).toHaveCount(1);
    await expect(rendered.locator('th')).toHaveText(['具体规定', '风险判断', '主要问题']);
    await expect(rendered.locator('tbody tr')).toHaveCount(3);
    await expect(rendered.locator('tbody tr').first().locator('td')).toHaveText(['绩效不合格，无补偿解除', '高风险', '不等于严重违纪']);
    await expect(rendered.locator('td .dil-text')).toHaveText(['高风险', '门槛模糊', '原则上可合法']);
    await expect(prose.locator('strong')).toHaveText('说明');
    await expect(prose).not.toContainText('|');
    await expect(prose).not.toContainText('\uE000EV');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const rows = await rendered.locator('tbody tr').evaluateAll(elements => elements.map(row =>
        Array.from(row.children, cell => ({ top: cell.getBoundingClientRect().top, height: cell.getBoundingClientRect().height }))));
      for (const cells of rows) {
        expect(cells).toHaveLength(3);
        expect(new Set(cells.map(cell => cell.top)).size).toBe(1);
        expect(new Set(cells.map(cell => cell.height)).size).toBe(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    }
  });
}

test('resolved images use compiled resolution order, load on click and survive expansion', async ({ page }) => {
  let imageRequests = 0;
  await page.route('https://images.example/**', route => { imageRequests++; return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=', 'base64') }); });
  const body = '<box>\n  <AsyncImage query="第一张"/>\n  <AsyncImage query="第二张"/>\n</box>';
  const metadata = { chatgpt_ui: { model_dil_v2: { code: '__dil.jsx(AsyncImage,{"__resolutionId":__dilConstants["0"]});__dil.jsx(AsyncImage,{"__resolutionId":__dilConstants["1"]})', constants: { '0': 'z-first', '1': 'a-second' }, appData: { opGenui: { componentResults: { 'a-second': { componentName: 'AsyncImage', state: { images: [{ title: '第二张图', content_url: 'https://images.example/second.png' }] } }, 'z-first': { componentName: 'AsyncImage', state: { images: [{ title: '第一张图', content_url: 'https://images.example/first.png' }] } } } } } } } };
  await fixture(page, body, metadata, true, body + '\n\n完整回答的后半段。');
  await expect(page.locator('.dil-image figcaption').first()).toHaveText('第一张图');
  await expect(page.locator('.dil-image figcaption').last()).toHaveText('第二张图');
  expect(imageRequests).toBe(0);
  await page.locator('.dil-load-image').first().click();
  await expect(page.locator('.dil-image img')).toHaveAttribute('src', 'https://images.example/first.png');
  await expect.poll(() => imageRequests).toBe(1);
  await page.locator('.expand-message').click();
  await expect(page.locator('.dil-response')).toContainText('完整回答的后半段');
  await expect(page.locator('.dil-load-image')).toHaveCount(2);
});

test('state and conditionals render while arbitrary JavaScript stays inert', async ({ page }) => {
  await fixture(page, '{@body const [seats,setSeats] = DIL.useState(8)}\n{@body const price = seats*29}\n<box><title>${price}/mo</title>{#if seats > 5}<text>团队方案</text>{:else}<text>个人方案</text>{/if}<slider value={seats}/><button onClick={()=>{window.xss=1}}>确认</button></box>');
  await expect(page.locator('.dil-title')).toHaveText('$232/mo');
  await expect(page.locator('.dil-response')).toContainText('团队方案');
  await expect(page.locator('.dil-response')).not.toContainText('个人方案');
  await expect(page.locator('input.dil-slider')).toHaveValue('8');
  expect(await page.evaluate(() => 'xss' in window)).toBeFalsy();
});

test('SVG diagrams preserve their text and following paragraphs', async ({ page }) => {
  await fixture(page, '<box>\n  <svg viewBox="0 0 340 84" width="100%">\n    {#each [{x:6,t:"男主参考"},{x:119,t:"女主参考"}] as v,i}\n      <rect x={v.x} y="4" width="102" height="29" fill="#64748b"/>\n      <text x={v.x+51} y="23">{v.t}</text>\n      {#if i<1}<path d={`M${v.x+94} 27 h22`} stroke="currentColor"/>{/if}\n    {/each}\n  </svg>\n  图片负责人物和场景一致性，文字决定新的画面构图和镜头运动。\n</box>');
  await expect(page.locator('.dil-response svg text')).toHaveText(['男主参考', '女主参考']);
  await expect(page.locator('.dil-response svg path')).toHaveAttribute('d', 'M100 27 h22');
  await expect(page.locator('.dil-response')).toContainText('图片负责人物和场景一致性');
});

test('ordinary Markdown, partial DIL and hostile markup stay readable and sanitized', async ({ page }) => {
  const body = '# 普通 Markdown\n\n**强调**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```html\n<box>原样</box>\n```\n\n<script>window.xss=1</script><img src="https://evil.example/a" onerror="window.xss=1">\n\n[危险](javascript:alert(1))';
  await fixture(page, body);
  await expect(page.locator('.prose h1')).toHaveText('普通 Markdown');
  await expect(page.locator('.prose strong')).toHaveText('强调');
  await expect(page.locator('.prose table')).toContainText('2');
  await expect(page.locator('.prose pre code')).toHaveText('<box>原样</box>\n');
  await expect(page.locator('.prose img,.prose script,.prose [onerror],.prose a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => 'xss' in window)).toBeFalsy();
  await page.unroute('**/api/**');
  await fixture(page, '<box>\n  **尚未闭合的回答**\n\n  正文仍然可读。\n  <AsyncImage query="未保存的图片"/>');
  await expect(page.locator('.dil-response strong')).toHaveText('尚未闭合的回答');
  await expect(page.locator('.dil-response')).toContainText('正文仍然可读');
  await expect(page.locator('.dil-image')).toContainText('图片未包含在存档中');
});

test('pension comparison layouts show cards, ratios and progress bars outside the source disclosure', async ({page})=>{
  const body=`# 制度比较\n\n<box border radius="xl" padding={3} gap={3}><grid columns={3} gap={2}><grid-item><box background="surface-secondary" radius="lg" padding={3}><text weight="medium" size="sm">老人</text><text size="xs">改革前已退休</text></box></grid-item><grid-item><text>中人</text></grid-item><grid-item><text>新人</text></grid-item></grid></box>\n\n<row align="center" gap={1}><box flex={3} background="rgba(67,132,211,0.14)"><text>改革前工作年限</text></box><box flex={2} background="rgba(32,153,105,0.13)"><text>改革后工作年限</text></box></row>\n\n<box background="surface-tertiary" height="9px" radius="full" clip><box background="#3C86D1" width="75%" height="100%" radius="full"/></box>\n\n<box><title size="2xl" tabularNums>43.2万元</title><text color="secondary" size="xs">缴费累计额</text></box>\n\n\\[\\text{基本养老金}=\\text{基础养老金}+\\text{个人账户养老金}\\]\n\n后续完整正文。`;
  await fixture(page,body);
  const prose=page.locator('.dil-response');
  await expect(prose.locator('.dil-grid-item')).toHaveCount(3);
  await expect(prose).toContainText('改革前已退休');
  await expect(prose).toContainText('后续完整正文');
  await expect(page.locator('.dil-source')).not.toHaveAttribute('open');
  await expect(page.locator('.dil-source summary')).toHaveText('查看布局标记（正文已展示）');
  await expect(page.locator('.dil-note')).toHaveCount(0);
  await expect(prose.locator('math')).toHaveCount(1);
  const boxes=prose.locator('.dil-row > .dil-box');
  expect(await boxes.first().evaluate(el=>getComputedStyle(el).flexGrow)).toBe('3');
  expect(await boxes.last().evaluate(el=>getComputedStyle(el).flexGrow)).toBe('2');
  const track=prose.locator('.dil-box').filter({has:page.locator('[data-dil-layout*="75%"]')});
  expect(await track.evaluate(el=>el.getBoundingClientRect().height)).toBe(9);
  const fill=prose.locator('[data-dil-layout*="75%"]');
  expect(await fill.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(60, 134, 209)');
  expect(await fill.evaluate(el=>el.getBoundingClientRect().width/el.parentElement!.getBoundingClientRect().width)).toBeCloseTo(.75,2);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

const pensionFormula = String.raw`\[
\text{基础养老金}=
\frac{S+I}{2}\times N\times1\%
\]`;

for (const nested of [false, true]) {
  test(`TeX renders fractions, percentages and inline variables${nested ? ' inside DIL' : ' in Markdown'}`, async ({ page }) => {
    const content = pensionFormula + '\n\n' + String.raw`其中，\(S\) 是基数，\(N\) 是年限。` + '\n\n' + String.raw`\[\text{个人账户养老金}=\frac{\text{累计储存额}}{\text{计发月数}}\]`;
    await fixture(page, nested ? `<box padding={3}>\n${content}\n</box>` : content);
    const prose = page.locator('.prose');
    await expect(prose.locator('math')).toHaveCount(4);
    await expect(prose.locator('mfrac')).toHaveCount(2);
    await expect(prose.locator('math mi').filter({ hasText: '%' })).toHaveCount(1);
    await expect(prose.locator('math').first().locator('mtext')).toHaveText('基础养老金');
    await expect(prose.locator('math').first().locator('mfrac mi')).toHaveText(['S', 'I']);
    await expect(prose.locator('math').first()).toHaveText('基础养老金=S+I2×N×1%');
    await expect(prose.locator('math[display="block"]')).toHaveCount(2);
    await expect(page.locator('.dil-note')).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const fraction = await prose.locator('mfrac').first().evaluate(node => ({
        numerator: node.children[0].getBoundingClientRect().bottom,
        denominator: node.children[1].getBoundingClientRect().top,
      }));
      expect(fraction.numerator).toBeLessThan(fraction.denominator);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    }
  });
}

test('copied display blocks render while brackets, links and dollar amounts remain text', async ({ page }) => {
  const copied = pensionFormula.replace(/\\([\[\]%])/g, '$1');
  await fixture(page, copied + '\n\n[\n普通方括号\n]\n\n[文档](https://example.com)\n\n价格 $100 和 $200。\n\n$$x^2+1$$');
  await expect(page.locator('.prose math')).toHaveCount(2);
  await expect(page.locator('.prose math mi').filter({ hasText: '%' })).toHaveCount(1);
  await expect(page.locator('.prose')).toContainText('普通方括号');
  await expect(page.locator('.prose')).toContainText('价格 $100 和 $200。');
  await expect(page.locator('.prose a')).toHaveAttribute('href', 'https://example.com');
});

test('code stays literal across longer fences, inline code and unclosed fences', async ({ page }) => {
  const code = 'demo\n```\n' + pensionFormula + '\n\n' + pensionFormula.replace(/\\([\[\]%])/g, '$1') + '\n<box>{keepMe}</box>';
  const tildeCode = '~~~\n' + pensionFormula + '\n{keepMe}';
  const unclosed = pensionFormula + '\n{alsoKeepMe}';
  await fixture(page, '<box>正文组件</box>\n\n````markdown\n' + code + '\n````\n\n~~~~latex\n' + tildeCode + '\n~~~~\n\n`' + String.raw`\(\frac{S+I}{2}\)` + '`\n\n' + pensionFormula + '\n\n```latex\n' + unclosed);
  await expect(page.locator('.dil-response pre code')).toHaveText([code + '\n', tildeCode + '\n', unclosed + '\n']);
  await expect(page.locator('.dil-response p code')).toHaveText(String.raw`\(\frac{S+I}{2}\)`);
  await expect(page.locator('.dil-response math')).toHaveCount(1);
  await expect(page.locator('.dil-note')).toHaveCount(0);
});

test('expanded formulas and search highlighting preserve the MathML structure', async ({ page }) => {
  await fixture(page, '<box>截断内容</box>', {}, true, '<box>\n' + pensionFormula + '\n</box>');
  await page.locator('.expand-message').click();
  const math = page.locator('.dil-response math');
  await expect(math.locator('mfrac')).toHaveCount(1);
  const initial = await math.evaluate(node => node.outerHTML);
  await page.locator('#session-search').click();
  for (const query of ['基础养老金', 'N']) {
    await page.locator('#local-query').fill(query);
    await expect(page.locator('.math-search-hit')).toHaveCount(1);
    expect(await math.evaluate(node => node.outerHTML)).toBe(initial);
    await expect(math.locator('mark,button')).toHaveCount(0);
  }
  await page.locator('#close-local-search').click();
  await expect(page.locator('.math-search-hit')).toHaveCount(0);
  expect(await math.evaluate(node => node.outerHTML)).toBe(initial);
});

test('invalid TeX keeps its source and following content without enabling archived HTML', async ({ page }) => {
  await fixture(page, '<box>\n' + String.raw`\[\unknownCommand{broken}\]` + '\n\n后续 **正文**。\n\n' + String.raw`\(\text{<img src=x onerror=alert(1)>}\)` + '\n</box>');
  await expect(page.locator('.dil-response')).toContainText(String.raw`\unknownCommand{broken}`);
  await expect(page.locator('.dil-response strong')).toHaveText('正文');
  await expect(page.locator('.prose img,.prose script,.prose [onerror]')).toHaveCount(0);
  await expect(page.locator('.dil-note')).toHaveCount(0);
});


const editorDirectory = `<box border radius="lg" padding={3} gap={2}>
  <row align="center" gap={2}>
    <icon name="folder" color="#D6A34A" size="xl"/>
    **MyMarkdownEditor/**
  </row>
  <box padding={{left:4}} gap={2}>
    <row align="center" gap={2}>
      <icon name="file-code" color="success"/>
      **MyMarkdownEditor.exe**
      <badge color="success">Native AOT</badge>
    </row>
    <row align="center" gap={2}>
      <icon name="folder" color="#D6A34A"/>
      **Assets/**
      <text color="secondary" size="xs">图标、图片、字体等（可选择外置）</text>
    </row>
    <row align="center" gap={2}>
      <icon name="folder" color="#D6A34A"/>
      **Themes/**
      <text color="secondary" size="xs">用户可自定义主题</text>
    </row>
    <row align="center" gap={2}>
      <icon name="folder" color="#D6A34A"/>
      **Plugins/**
      <text color="secondary" size="xs">插件目录（如果未来支持）</text>
    </row>
    <row align="center" gap={2}>
      <icon name="folder" color="#D6A34A"/>
      **Templates/**
      <text color="secondary" size="xs">文档模板</text>
    </row>
  </box>
</box>`;

test('Markdown editor directory preserves compact rows and indentation after expansion', async ({page}) => {
  await fixture(page, '假设你的 Markdown 编辑器最终发布成这样：\n\n' + editorDirectory + '\n\n后续 **正文**。', {}, true);
  for (const expanded of [false, true]) {
    if (expanded) await page.locator('.expand-message').click();
    const directory = page.locator('.dil-response > .dil-box');
    await expect(directory.locator('.dil-row')).toHaveCount(6);
    await expect(directory.locator('.dil-icon svg')).toHaveCount(6);
    await expect(directory.locator('br')).toHaveCount(0);
    await expect(directory.locator('strong')).toHaveText(['MyMarkdownEditor/', 'MyMarkdownEditor.exe', 'Assets/', 'Themes/', 'Plugins/', 'Templates/']);
    await expect(directory.locator('.dil-badge')).toHaveText('Native AOT');
    await expect(page.locator('.dil-response')).toContainText('后续 正文。');
    for (const width of [1440, 512, 390]) {
      await page.setViewportSize({width, height:900});
      const rows = await directory.locator('.dil-row').evaluateAll(nodes => nodes.map(row => {
        const icon = row.querySelector('.dil-icon')!.getBoundingClientRect();
        const label = row.querySelector('strong')!.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        return {direction:getComputedStyle(row).flexDirection, iconLeft:icon.left, iconRight:icon.right, labelLeft:label.left,
          centers:Math.abs((icon.top+icon.bottom-label.top-label.bottom)/2), height:bounds.height, width:bounds.width, scroll:row.scrollWidth};
      }));
      for (const row of rows) {
        expect(row.direction).toBe('row');
        expect(row.iconRight).toBeLessThanOrEqual(row.labelLeft);
        expect(row.centers).toBeLessThan(3);
        expect(row.scroll).toBeLessThanOrEqual(Math.ceil(row.width));
      }
      expect(rows[1].iconLeft-rows[0].iconLeft).toBe(16);
      if (width >= 512) {
        expect(await directory.evaluate(el=>el.getBoundingClientRect().height)).toBeLessThan(240);
        const badge = await directory.locator('.dil-badge').boundingBox();
        const label = await directory.locator('strong').nth(1).boundingBox();
        expect(Math.abs(badge!.y+badge!.height/2-label!.y-label!.height/2)).toBeLessThan(3);
      }
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
      if (!expanded) await directory.screenshot({path:`artifacts/mewui-after-${width}.png`});
    }
  }
});

test('compact rows preserve explicit breaks and leave block Markdown and card rows unchanged', async ({page}) => {
  await fixture(page, `<row><icon name="folder"/>名称  \n第二行<badge>标记</badge></row>
<row>第一段。\n\n第二段。</row>
<row>\n\n\`\`\`text\n<icon name="folder"/>\n\`\`\`\n\n</row>
<row><box>卡片一</box><box>卡片二</box></row>

普通正文第一行\n普通正文第二行`);
  const rows = page.locator('.dil-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveClass(/dil-row-inline/);
  await expect(rows.nth(0).locator('br')).toHaveCount(1);
  for (const i of [1,2,3]) await expect(rows.nth(i)).not.toHaveClass(/dil-row-inline/);
  await expect(rows.nth(1).locator('p')).toHaveText(['第一段。', '第二段。']);
  await expect(rows.nth(2).locator('pre code')).toHaveText('<icon name="folder"/>\n');
  await expect(rows.nth(3).locator('.dil-box')).toHaveCount(2);
  await expect(page.locator('.dil-response > p br')).toHaveCount(1);
  await page.setViewportSize({width:390, height:900});
  expect(await rows.nth(3).evaluate(el=>getComputedStyle(el).flexDirection)).toBe('column');
});


test('FDE archived calculator and checklist react locally through expansion and keyboard input', async ({page}) => {
  const body = (await readFile(resolve('tests/fixtures/fde-first-order.txt'), 'utf8')) + '\n\n[参考](https://example.com/reference)\n\n' + String.raw`\(x^2\)` + '\n\n```html\n<slider value={45}/>\n```';
  await fixture(page, body, {}, true, body + '\n\n完整正文 **仍然保留**。');
  for (const expanded of [false, true]) {
    if (expanded) await page.locator('.expand-message').click();
    const sliders = page.locator('.dil-slider');
    const checks = page.locator('.dil-response').getByRole('checkbox');
    await expect(sliders).toHaveCount(4);
    await expect(checks).toHaveCount(6);
    const quote = page.locator('.dil-title').filter({hasText:'¥'});
    await expect(quote).toHaveText('¥17,400');
    await expect(page.locator('.dil-response')).toContainText('3.8 周完成');
    const mathBefore = await page.locator('.prose math').evaluate(node=>node.outerHTML);
    await sliders.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(sliders.first()).toBeFocused();
    await expect(sliders.first()).toHaveValue('50');
    await expect(quote).toHaveText('¥19,200');
    await expect(page.locator('.dil-response')).toContainText('4.2 周完成');
    await sliders.first().scrollIntoViewIfNeeded();
    const range = await sliders.first().boundingBox();
    const handle = await sliders.first().elementHandle();
    await page.mouse.move(range!.x + range!.width * .38, range!.y + range!.height / 2);
    await page.mouse.down();
    await page.mouse.move(range!.x + range!.width * .85, range!.y + range!.height / 2, {steps:8});
    await page.mouse.up();
    expect(Number(await sliders.first().inputValue())).toBeGreaterThan(50);
    await expect(quote).not.toHaveText('¥19,200');
    expect(await handle!.evaluate(node => node === document.querySelector('.dil-slider'))).toBeTruthy();
    await sliders.first().fill('50');
    await expect(quote).toHaveText('¥19,200');
    for (const [i, value] of [[1,'400'],[2,'2000'],[3,'30']]) {
      await sliders.nth(Number(i)).fill(String(value));
    }
    await expect(quote).toHaveText('¥28,600');
    expect(await page.locator('.prose math').evaluate(node=>node.outerHTML)).toBe(mathBefore);
    await expect(page.locator('.dil-response a')).toHaveAttribute('target','_blank');
    await expect(page.locator('.dil-response .code-copy')).toHaveCount(1);
    await expect(page.locator('.dil-response')).toContainText('¥2,000');
    await checks.nth(0).check(); await checks.nth(2).check();
    await expect(page.locator('.dil-badge')).toHaveText('2/6');
    await checks.nth(0).uncheck();
    await expect(checks.nth(2)).toBeChecked();
    await expect(page.locator('.dil-badge')).toHaveText('1/6');
    for (const check of await checks.all()) await check.check();
    await expect(page.locator('.dil-badge')).toHaveText('6/6');
    await expect(page.locator('.dil-badge')).toHaveClass(/dil-success/);
    await checks.nth(5).uncheck();
    await expect(page.locator('.dil-badge')).toHaveText('5/6');
    await expect(page.locator('.dil-badge')).not.toHaveClass(/dil-success/);
    await expect(quote).toHaveText('¥28,600');
    await expect(page.locator('.dil-response')).not.toContainText('存档快照');
    await expect(page.locator('.dil-note')).toHaveCount(0);
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    }
    if (expanded) {
      await expect(page.locator('.dil-response strong').last()).toHaveText('仍然保留');
      await page.locator('.dil-response').screenshot({path:'artifacts/fde-interactive-mobile.png'});
    }
  }
});

test('unsupported control handlers and hostile function calls cannot execute archived JavaScript', async ({page}) => {
  await fixture(page, `{@body const [v,setV]=DIL.useState(20)}
<box><slider value={v} onChange={x=>window.alert(x)}/><checkbox onChange={x=>({}).constructor.constructor("window.xss=1")()}>危险处理器</checkbox>
<text>{Math.constructor("window.xss=1")()}</text><text>{(12).toFixed(9999999)}</text></box>`);
  await page.locator('.dil-slider').fill('30');
  await page.getByRole('checkbox', {name:'危险处理器'}).check();
  expect(await page.evaluate(()=> 'xss' in window)).toBeFalsy();
  await expect(page.locator('.prose script,.prose [onchange],.prose [oninput]')).toHaveCount(0);
});
