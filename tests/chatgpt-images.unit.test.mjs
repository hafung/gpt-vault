import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../scripts/capture-chatgpt-images.js', import.meta.url),'utf8');
const run = (await import('data:text/javascript,'+encodeURIComponent('export default '+source))).default;
globalThis.location = {origin:'app://-'};
globalThis.FileReader = class {
  readAsDataURL(blob) { blob.arrayBuffer().then(bytes=>{this.result='data:'+blob.type+';base64,'+Buffer.from(bytes).toString('base64');this.onload();}); }
};
const native = 'data:text/javascript,'+encodeURIComponent(`
export function resolver(id){return {resolveAsset:async(file)=>({kind:'available',downloadUrl:'https://private.example/'+file,requestHeaders:{Authorization:'never-export-this'}})}}
export async function download(target,signal,limit){
  if(target.downloadUrl.includes('blocked'))throw Error('unavailable');
  if(limit<4)throw Error('limit');
  return new Blob(['test'],{type:target.downloadUrl.endsWith('.md')?'text/markdown':'image/png'});
}
export async function sandbox({conversationId,messageId,sandboxPath}) {
  if (!conversationId || !messageId || sandboxPath.includes('expired')) throw Error('expired');
  return {downloadUrl:'https://private.example'+sandboxPath,requestHeaders:{Authorization:'never-export-this'}};
}`);
const bindings = {module:native,resolver:'resolver',download:'download',sandbox:'sandbox'};
const context = {job:{id:'test'},conversation:{messages:[]},bindings,deadline:Date.now()+60000,budget:1024};

test('attachment downloads stay deduplicated and native auth never leaves the page',async()=>{
  const result=JSON.parse(await run({...context,conversation:{messages:[{content:{parts:[{asset_pointer:'sediment://file_test'},{asset_pointer:'sediment://file_test'}]}}]}}));
  assert.equal(result.images.length,1);
  assert.equal(result.images[0].reference,'sediment://file_test');
  assert.equal(result.images[0].data,Buffer.from('test').toString('base64'));
  assert.equal(result.pending_images,0);
  assert.ok(!JSON.stringify(result).includes('never-export-this'));
});

test('image download falls back to thumbnails while keeping the primary reference',async()=>{
  const result=JSON.parse(await run({...context,job:{id:'test',images:[{reference:'https://images.example/blocked.png',urls:['https://images.example/blocked.png','https://images.example/thumb.png']}]}}));
  assert.equal(result.images[0].reference,'https://images.example/blocked.png');
  assert.equal(result.pending_images,0);
});

test('known images, exhausted budgets and missing body pages preserve progress',async()=>{
  const images=[{reference:'sediment://file_test'}];
  const known=JSON.parse(await run({...context,job:{id:'test',images,known_images:{'sediment://file_test':'cached'}}}));
  assert.equal(known.images.length,0);
  assert.equal(known.pending_images,0);
  const deferred=JSON.parse(await run({...context,conversation:null,job:{id:'test',images},budget:0}));
  assert.equal(deferred.pending_images,1);
  const recovered=JSON.parse(await run({...context,conversation:null,job:{id:'test',images}}));
  assert.equal(recovered.images.length,1);
});

test('sandbox documents and images retain Chinese filenames and stay offline after archival',async()=>{
  const ref='sandbox:/workspace/scratch/珍珠奶茶.md';
  const result=JSON.parse(await run({...context,budget:4096,conversation:{messages:[{id:'owner',content:{parts:['[下载]('+ref+')\n[再次下载](sandbox:/workspace/scratch/'+encodeURIComponent('珍珠奶茶.md')+')\n![分镜](sandbox:/workspace/scratch/board.png)']}}]}}));
  assert.equal(result.files.length,2);
  assert.equal(result.files[0].reference,ref);
  assert.equal(result.pending_files,0);
  assert.ok(!JSON.stringify(result).includes('never-export-this'));
  const recovered=JSON.parse(await run({...context,conversation:null,job:{id:'test',files:[{reference:ref,message_id:'owner'}]}}));
  assert.equal(recovered.files.length,1);
  const known=JSON.parse(await run({...context,job:{id:'test',files:[{reference:ref,message_id:'owner'}],known_files:{[ref]:'cached'}}}));
  assert.equal(known.pending_files,0);
  const expired=JSON.parse(await run({...context,job:{id:'test',files:[{reference:'sandbox:/mnt/data/expired.md',message_id:'owner'}]}}));
  assert.equal(expired.pending_files,1);
  assert.equal(expired.files.length,0);
});
