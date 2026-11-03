import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../scripts/capture-chatgpt-conversation.js', import.meta.url), 'utf8');
const module = 'data:text/javascript,' + encodeURIComponent('export const Request={safeGet:(...args)=>globalThis.captureGet(...args)}');
globalThis.location = {origin:'app://-'};

async function capture(first, older) {
  let reads = 0;
  globalThis.captureGet = async () => ++reads === 1
    ? {conversation_id:'fixture', messages:first, page_info:{has_previous_page:true,start_cursor:'older'}}
    : {conversation_id:'fixture', messages:older, page_info:{has_previous_page:false}};
  const expression = source.replace('__JOB__', JSON.stringify({id:'fixture'}))
    .replace('__DEADLINE__', String(Date.now()+60000)).replace('__MODULE__', JSON.stringify(module));
  return JSON.parse(await Function('return '+expression)());
}

test('pagination preserves newest image-only answers over older textual fallbacks', async () => {
  const image = {id:'image', content:{parts:[{asset_pointer:'sediment://generated'}]}};
  const placeholder = {id:'image', content:{parts:['older fallback']}};
  const result = await capture([image], [placeholder]);
  assert.equal(result.complete, true);
  assert.equal(result.pages, 2);
  assert.deepEqual(result.conversation.messages, [image]);
  assert.equal(result.conversation.current_node, 'image');
});

test('overlapping pages can fill an image placeholder without losing the newest current node', async () => {
  const image = {id:'image', content:{parts:[{image_asset_pointer:{asset_pointer:'file-service://generated'}}]}};
  const recap = {id:'recap',content:{content_type:'reasoning_recap',content:'Worked for 40s'}};
  const result = await capture([{id:'image', content:{parts:[]}},recap], [image,{id:'recap',content:{parts:[]}}]);
  assert.deepEqual(result.conversation.messages, [image,recap]);
  assert.equal(result.conversation.current_node, 'recap');
});
