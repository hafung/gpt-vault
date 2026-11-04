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
