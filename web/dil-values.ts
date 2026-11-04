// A bounded interpreter for DIL values. Archived JavaScript is never executed.
export type Scope = Record<string, unknown>;
const callable = new WeakMap<object, (args: unknown[]) => unknown>();
export function dilFunction(fn: (args: unknown[]) => unknown): object {
  const value = Object.create(null) as object; callable.set(value, fn); return value;
}
export const isDilFunction = (value: unknown): boolean => value !== null && typeof value === 'object' && callable.has(value);
export function callDil(value: unknown, args: unknown[]): unknown {
  return value !== null && typeof value === 'object' ? callable.get(value)?.(args) : undefined;
}
const mathMethods: Record<string, (...values: number[]) => number> = { round: Math.round, ceil: Math.ceil, floor: Math.floor, abs: Math.abs, min: Math.min, max: Math.max };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export function staticValue(source: string, scope: Scope, budget = { steps: 12000, calls: 0 }): unknown {
  if (--budget.steps < 0 || budget.calls > 40 || source.length > 20000) return undefined;
  source = source.trim();
  if (source.startsWith('`') && source.endsWith('`')) {
    let valid = true;
    const value = source.slice(1, -1).replace(/\$\{([^{}]+)\}/g, (_, expression: string) => {
      const result = staticValue(expression, scope, budget);
      if (typeof result !== 'string' && typeof result !== 'number') { valid = false; return ''; }
      return String(result);
    });
    return valid && !value.includes('${') ? value : undefined;
  }
  const tokens = source.match(/\s+|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?:\d+(?:\.\d+)?)|(?:[A-Za-z_$][\w$]*)|(?:=>|\.\.\.|===|!==|==|!=|>=|<=|&&|\|\||\?\?)|./g)?.filter(t => !/^\s+$/.test(t)) || [];
  if (tokens.length > 2000) return undefined;
  let i = 0, depth = 0, active = true;
  const precedence: Record<string, number> = { '??': 1, '||': 1, '&&': 2, '===': 3, '!==': 3, '==': 3, '!=': 3, '>': 4, '<': 4, '>=': 4, '<=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
  const take = (token: string) => { if (tokens[i] !== token) throw new Error('Incomplete value'); i++; };
  const key = () => {
    const token = tokens[i++];
    if (!token) throw new Error('Missing key');
    const value = /^['"]/.test(token) ? string(token) : token;
    if (forbidden.has(value)) throw new Error('Invalid key');
    return value;
  };
  function string(token: string): string {
    if (token[0] === '"') return JSON.parse(token);
    return token.slice(1, -1).replace(/\\(['\\nrt])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c));
  }
  function atom(): unknown {
    if (--budget.steps < 0) throw new Error('Value budget exceeded');
    if (++depth > 40) throw new Error('Value too deep');
    const token = tokens[i++];
    let result: unknown;
    const arrow = token === '(' ? tokens.indexOf(')', i) : i;
    if ((token === '(' && arrow >= i && tokens[arrow + 1] === '=>' && tokens.slice(i, arrow).every(t => /^[\w$]+$/.test(t) || t === ',')) || tokens[i] === '=>') {
      const params = token === '(' ? tokens.slice(i, arrow).filter(t => t !== ',') : [token];
      i = token === '(' ? arrow + 2 : i + 1;
      const start = i; let nesting = 0;
      while (i < tokens.length) {
        const t = tokens[i];
        if (nesting === 0 && [',', ')', ']', '}'].includes(t)) break;
        if (['(', '[', '{'].includes(t)) nesting++;
        if ([')', ']', '}'].includes(t)) nesting--;
        i++;
      }
      const body = tokens.slice(start, i).join(' ');
      result = dilFunction(args => {
        if (++budget.calls > 40) return undefined;
        try { return staticValue(body, Object.assign(Object.create(null), scope, Object.fromEntries(params.map((p, n) => [p, args[n]]))), budget); }
        finally { budget.calls--; }
      });
    }
    else if (token === '(') { result = expression(); take(')'); }
    else if (token === '[') {
      const values: unknown[] = [];
      while (i < tokens.length && tokens[i] !== ']') { if (tokens[i] === '...') { i++; const spread = expression(); if (!Array.isArray(spread) || spread.length > 1000) throw new Error('Invalid spread'); values.push(...spread); }
        else values.push(expression()); if (tokens[i] !== ',') break; i++; }
      take(']'); result = values;
    } else if (token === '{') {
      const values = Object.create(null) as Scope;
      while (i < tokens.length && tokens[i] !== '}') { const name = key(); take(':'); values[name] = expression(); if (tokens[i] !== ',') break; i++; }
      take('}'); result = values;
    } else if (token === '!' || token === '-' || token === '+') {
      const value = atom(); result = token === '!' ? !value : token === '-' ? -Number(value) : Number(value);
    } else if (/^['"]/.test(token || '')) result = string(token);
    else if (/^\d/.test(token || '')) result = Number(token);
    else if (token === 'true' || token === 'false') result = token === 'true';
    else if (token === 'null') result = null;
    else if (token === 'Math') result = math;
    else if (token && !forbidden.has(token) && Object.hasOwn(scope, token)) result = scope[token];
    else if (active) throw new Error('Unknown value');
    while (tokens[i] === '.' || tokens[i] === '[' || tokens[i] === '(') {
      if (tokens[i] === '(') {
        i++; const args: unknown[] = [];
        while (i < tokens.length && tokens[i] !== ')') { args.push(expression()); if (tokens[i] !== ',') break; i++; }
        take(')'); result = active ? callDil(result, args) : undefined; continue;
      }
      let property: string;
      if (tokens[i++] === '.') property = key();
      else { property = String(expression()); take(']'); }
      if (forbidden.has(property)) throw new Error('Invalid property');
      const receiver = result;
      if (typeof receiver === 'number' && property === 'toFixed') result = dilFunction(args => receiver.toFixed(Math.max(0, Math.min(20, Number(args[0]) || 0))));
      else if (typeof receiver === 'number' && property === 'toLocaleString') result = dilFunction(args => receiver.toLocaleString(['zh-CN', 'en-US'].includes(String(args[0])) ? String(args[0]) : 'zh-CN'));
      else if (Array.isArray(receiver) && receiver.length <= 1000 && property === 'includes') result = dilFunction(args => receiver.includes(args[0]));
      else if (Array.isArray(receiver) && receiver.length <= 1000 && property === 'filter') result = dilFunction(args => receiver.filter((v, index) => { if (--budget.steps < 0) throw new Error('Value budget exceeded'); return !!callDil(args[0], [v, index]); }));
      else if (Array.isArray(result) && property === 'length') result = result.length;
      else if (result !== null && typeof result === 'object' && Object.hasOwn(result, property)) result = (result as Scope)[property];
      else result = undefined;
    }
    depth--; return result;
  }
  function expression(min = 0): unknown {
    let left = atom();
    while (i < tokens.length && (precedence[tokens[i]] ?? -1) >= min) {
      const op = tokens[i++], wasActive = active;
      active = active && !(op === '&&' && !left || op === '||' && !!left || op === '??' && left != null);
      const right = expression(precedence[op] + 1); active = wasActive;
      switch (op) {
        case '+': left = typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right); break;
        case '-': left = Number(left) - Number(right); break;
        case '*': left = Number(left) * Number(right); break;
        case '/': left = Number(left) / Number(right); break;
        case '%': left = Number(left) % Number(right); break;
        case '==': case '===': left = left === right; break;
        case '!=': case '!==': left = left !== right; break;
        case '>': left = Number(left) > Number(right); break;
        case '<': left = Number(left) < Number(right); break;
        case '>=': left = Number(left) >= Number(right); break;
        case '<=': left = Number(left) <= Number(right); break;
        case '&&': left = left && right; break;
        case '||': left = left || right; break;
        case '??': left = left ?? right; break;
      }
    }
    if (min === 0 && tokens[i] === '?') {
      i++; const wasActive = active; active = wasActive && !!left;
      const yes = expression(); take(':'); active = wasActive && !left;
      const no = expression(); active = wasActive; left = left ? yes : no;
    }
    return left;
  }
  const math = Object.fromEntries(Object.entries(mathMethods).map(([name, fn]) => [name, dilFunction(args => fn(...args.map(Number)))]));
  try { const result = expression(); return i === tokens.length && !(typeof result === 'number' && !Number.isFinite(result)) ? result : undefined; }
  catch { return undefined; }
}
