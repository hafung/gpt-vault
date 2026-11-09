import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../web/dil-values.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {staticValue, dilFunction, callDil} = await import('data:text/javascript,' + encodeURIComponent(compiled));

test('archived formatter and collection updates use the bounded interpreter', () => {
  const scope = Object.create(null);
  scope.fmt = staticValue('n=>"¥"+Math.round(n).toLocaleString("zh-CN")', scope);
  assert.equal(staticValue('fmt((45*300+1000)*1.2)', scope), '¥17,400');
  assert.equal(staticValue('(45/12).toFixed(1)', scope), '3.8');
  scope.v = true; scope.i = 2;
  const update = staticValue('old=>v?[...old,i]:old.filter(x=>x!==i)', scope);
  assert.deepEqual(callDil(update, [[0]]), [0,2]);
  scope.v = false;
  assert.deepEqual(callDil(update, [[0,2]]), [0]);
  assert.equal(staticValue('[0,2].includes(2)', scope), true);
});

test('inactive branches do not call state setters', () => {
  const calls = [];
  const scope = {set: dilFunction(args => {calls.push(args[0]);return args[0];})};
  assert.equal(staticValue('true ? set(1) : set(2)', scope), 1);
  assert.equal(staticValue('false && set(3)', scope), false);
  assert.equal(staticValue('true || set(4)', scope), true);
  assert.equal(staticValue('5 ?? set(6)', scope), 5);
  assert.deepEqual(calls, [1]);
});

test('host functions and prototype access remain inaccessible', () => {
  let ran = false;
  const scope = {host:()=>{ran=true;}, obj:{}};
  for (const expression of ['host()', 'window.alert(1)', 'obj.constructor', 'Math.constructor("return window")()', 'obj["__proto__"]', 'fetch("https://example.com")']) {
    assert.equal(staticValue(expression, scope), undefined);
  }
  assert.equal(ran, false);
});

test('recursive expressions stop within the evaluation budget', () => {
  const scope = Object.create(null);
  scope.repeat = staticValue('n=>repeat(n+1)', scope);
  assert.equal(staticValue('repeat(0)', scope), undefined);
  assert.equal(staticValue('('.repeat(100) + '1' + ')'.repeat(100), scope), undefined);
});

test('preset options map object entries through array parameter destructuring', () => {
  const presetNames = {'commercial-beauty':'A — 高级商业人像','golden-hour':'E — 户外黄金时刻'};
  assert.deepEqual(staticValue('Object.entries(presetNames).map(([value,label])=>({value,label}))', {presetNames}).map(v=>({...v})), [
    {value:'commercial-beauty',label:'A — 高级商业人像'}, {value:'golden-hour',label:'E — 户外黄金时刻'},
  ]);
  assert.equal(staticValue('Object.constructor("return window")()', {}), undefined);
});

test('copy handlers resolve templates at click time and preserve literal user input', () => {
  let copied;
  const scope = {character:'C:\\new\\test ${literal}', GenUI:{copy:dilFunction(([value])=>{copied=value;})}};
  const handler = staticValue('()=>GenUI.copy(`CHARACTER:\\n${character}`)', scope);
  assert.equal(copied, undefined);
  callDil(handler, []);
  assert.equal(copied, 'CHARACTER:\n'+scope.character);
});

test('scorecard sums scores, maps updates and joins its current report', () => {
  const scope = {scores:[16,16,16,8,12,8,4],criteria:[{name:'结构',max:20},{name:'光照',max:20}]};
  assert.equal(staticValue('scores.reduce((a,b)=>a+b,0)', scope), 80);
  assert.equal(staticValue('[1,2,3].reduce((a,b)=>a+b)', scope), 6);
  assert.equal(staticValue('[].reduce((a,b)=>a+b,0)', scope), 0);
  assert.equal(staticValue('criteria.map((c,i)=>`${c.name}: ${scores[i]}/${c.max}`).join("\\n")+`\\n总分: ${total}/100`', {...scope,total:80}), '结构: 16/20\n光照: 16/20\n总分: 80/100');
  assert.deepEqual(callDil(staticValue('p=>p.map((x,j)=>j===i?v:x)', {i:1,v:14}), [scope.scores]), [16,14,16,8,12,8,4]);
  assert.equal(staticValue('[{}].join(" ")', {}), undefined);
  assert.equal(staticValue('[1].reduce((a,b)=>b.constructor("window.xss=1")(),0)', {}), undefined);
});
