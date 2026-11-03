import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

for (const outcome of ['success', 'failure', 'switch_conversation'] as const) {
  test(`single conversation sync preserves paginated list and selection after ${outcome}`, async ({page}) => {
    const stamp = Date.now()/1000;
    let running = false, started = false, done = false;
    const offsets: number[] = [];
    const sessions = Array.from({length:85}, (_, index) => ({
      id:`chatgpt:chat-${index}`, title:`历史会话 ${index}`, project:'ChatGPT', cwd:'',
      provider:'ChatGPT', platform:'Windows', model:'GPT', metadata:{desktop_cache:true},
      created:stamp-index-100, updated:stamp-index-100, message_count:1, total_count:1,
      favorite:0, hidden:0, project_hidden:0, preview:`会话 ${index} 的正文`,
    }));
    const target = sessions[55];
    const succeeds = outcome !== 'failure';
    const updated = () => ({...target, ...(done&&succeeds ? {title:'同步后的历史会话 55', message_count:2, total_count:2, updated:stamp+1} : {})});
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      const path = decodeURIComponent(url.pathname);
      if (path === '/api/sessions/'+target.id+'/sync') {
        started = running = true;
        return route.fulfill({json:{started:true}});
      }
      if (path === '/api/sync') {
        if (route.request().method() !== 'GET') throw Error('Unexpected global sync');
        return route.fulfill({json:{running, automatic:false, stage:running?'chatgpt_desktop_live':'done',
          started:stamp, finished:done?stamp+1:stamp, duration:1, done:done?1:0, total:1,
          imported:done&&succeeds?1:0, skipped:0, file:target.title, warnings:[],
          errors:done&&!succeeds?[{path:target.title,error:'会话可能已删除，本地已保存的对话仍保留'}]:[],
          ...(started?{session_id:target.id}:{}),
          ...(done&&succeeds?{session_result:{complete:true,pages:1,messages:2,streaming:false,missing_bodies:0}}:{}),
        }});
      }
      if (path === '/api/sessions') {
        const offset = Number(url.searchParams.get('offset')||0); offsets.push(offset);
        const items = sessions.map(s => s.id===target.id?updated():s).sort((a,b)=>b.updated-a.updated);
        return route.fulfill({json:{items:items.slice(offset,offset+35),offset:offset+35,more:offset+35<items.length}});
      }
      if (path.startsWith('/api/sessions/')) {
        const session = sessions.find(s=>path==='/api/sessions/'+s.id);
        if (!session) throw Error('Unexpected conversation '+path);
        const current = session.id===target.id?updated():session;
        const body = current.preview;
        return route.fulfill({json:{session:current,items:[{id:1,role:'assistant',kind:'text',phase:'',body,timestamp:stamp,metadata:{},length:body.length}],offset:0,total:current.message_count,more:false}});
      }
      if (path === '/api/stats') return route.fulfill({json:{sessions:85,messages:85,events:85,projects:1,favorites:0,projects_list:[],platforms:[],providers:[],last_sync:stamp,db_bytes:0,raw_bytes:0}});
      if (path === '/api/backup/status') return route.fulfill({json:{directory:'',job:null}});
      if (path === '/api/restore/status') return route.fulfill({json:{job:null}});
      if (path.startsWith('/api/')) throw Error('Unexpected API '+path);
      const asset = url.pathname.startsWith('/assets/')?url.pathname.slice(1):'index.html';
      return route.fulfill({body:await readFile(resolve('dist',asset)),contentType:asset.endsWith('.js')?'application/javascript':asset.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('/');
    await expect(page.locator('.conversation-card')).toHaveCount(35);
    await page.locator('#load-more').click();
    await expect(page.locator('.conversation-card')).toHaveCount(70);
    const card = page.locator(`.conversation-card[data-id="${target.id}"]`);
    await card.click();
    await expect(card).toHaveClass(/selected/);
    await page.locator('#session-sync').click();
    await expect(page.locator('#session-sync-feedback')).toContainText('正在重新读取');
    let selected = target.id;
    if (outcome === 'switch_conversation') {
      selected = sessions[56].id;
      await page.locator(`.conversation-card[data-id="${selected}"]`).click();
      await expect(page.locator('.reader-header h2')).toHaveText(sessions[56].title);
    }
    const scrollTop = await page.locator('#conversation-list').evaluate(el=>el.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    const order = await page.locator('.conversation-card').evaluateAll(cards=>cards.map(card=>(card as HTMLElement).dataset.id));
    running = false; done = true;
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#sync-status')).not.toContainText('正在同步');
    if (succeeds) await expect(card.locator('h3')).toHaveText('同步后的历史会话 55');
    else await expect(page.locator('#session-sync-feedback')).toContainText('会话可能已删除');
    await expect(page.locator('.conversation-card.selected')).toHaveAttribute('data-id',selected);
    expect(new URL(page.url()).searchParams.get('session')).toBe(selected);
    expect(await page.locator('.conversation-card').evaluateAll(cards=>cards.map(card=>(card as HTMLElement).dataset.id))).toEqual(order);
    expect(await page.locator('#conversation-list').evaluate(el=>el.scrollTop)).toBeCloseTo(scrollTop,0);
    expect(offsets).toEqual([0,35]);
    await page.locator('#load-more').click();
    await expect(page.locator('.conversation-card')).toHaveCount(85);
    expect(offsets).toEqual([0,35,70]);
  });
}
