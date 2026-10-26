import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

test('Desktop capture is opt-in, persists the setting and uses ordinary sync without an automatic restart',async({page})=>{
  let enabled=false;
  let running=false;
  const settings:unknown[]=[];
  const syncs:unknown[]=[];
  const repairs:unknown[]=[];
  const stamp=Date.now()/1000;
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    const method=route.request().method();
    if(url.pathname==='/api/sources')return route.fulfill({json:{sources:[],chatgpt:'',desktop_capture:{enabled,supported:true,port:19222}}});
    if(url.pathname==='/api/desktop-capture/repair'){repairs.push(route.request().postDataJSON());running=true;return route.fulfill({json:{started:true}});}
    if(url.pathname==='/api/desktop-capture'){
      const payload=route.request().postDataJSON();settings.push(payload);enabled=payload.enabled;
      return route.fulfill({json:{enabled,supported:true,port:19222}});
    }
    if(url.pathname==='/api/sync'){
      if(method==='POST'){syncs.push(route.request().postDataJSON());running=true;return route.fulfill({json:{started:true}});}
      return route.fulfill({json:{running,stage:running?'chatgpt_desktop_live':'done',done:0,total:0,imported:0,skipped:0,errors:[],warnings:[],file:'目标会话',started:stamp,finished:stamp,desktop_captured:0,desktop_pending:1}});
    }
    if(url.pathname==='/api/stats')return route.fulfill({json:{sessions:0,messages:0,events:0,projects:0,favorites:0,projects_list:[],platforms:[],providers:[],last_sync:stamp,db_bytes:0,raw_bytes:0}});
    if(url.pathname==='/api/sessions')return route.fulfill({json:{items:[],more:false,offset:0}});
    if(url.pathname==='/api/backup/status')return route.fulfill({json:{directory:'',job:null}});
    if(url.pathname==='/api/restore/status')return route.fulfill({json:{job:null}});
    if(url.pathname.startsWith('/api/'))throw new Error('Unexpected API '+url.pathname);
    const asset=url.pathname.startsWith('/assets/')?url.pathname.slice(1):'index.html';
    return route.fulfill({body:await readFile(resolve('dist',asset)),contentType:asset.endsWith('.js')?'application/javascript':asset.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('/');
  await page.locator('#sources-button').click();
  const toggle=page.getByRole('checkbox',{name:'桌面同步与历史补全'});
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect.poll(()=>settings.length).toBe(1);
  expect(settings[0]).toEqual({enabled:true});
  await expect.poll(()=>syncs.length).toBe(1);
  expect(syncs[0]).toEqual({full:false});
  await expect(page.locator('#sync-status')).toContainText('正在同步桌面会话');
  await expect(toggle).toBeEnabled();
  expect(repairs).toHaveLength(0);
  running=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#sync-button')).toBeEnabled();
  await page.locator('#sources-dialog').getByRole('button',{name:'关闭',exact:true}).click();
  await page.locator('#sources-button').click();
  const repair=page.getByRole('button',{name:'恢复补全连接并同步',exact:true});
  page.once('dialog',dialog=>dialog.dismiss());
  await repair.click();
  expect(repairs).toHaveLength(0);
  page.once('dialog',dialog=>dialog.accept());
  await repair.click();
  await expect.poll(()=>repairs.length).toBe(1);
  expect(repairs[0]).toEqual({confirmed:true});
  await toggle.uncheck();
  await expect.poll(()=>settings.length).toBe(2);
  expect(settings[1]).toEqual({enabled:false});
  expect(syncs).toHaveLength(1);
});
