/** 受限表达式脚本：给「脚本」规则提供一套可校验、无副作用的小型表达式语言。
 *
 * 设计取舍：文件名规则需要可预测、可预览、可静态校验，所以不执行任意 JS。
 * 语言只有字符串/数字/布尔、四则与比较、三元、固定函数表；没有变量赋值、循环、I/O，
 * 也没有能触到宿主环境的入口。语法在应用前完整解析，未知变量/函数、参数个数、
 * 字面量正则非法都会在规则卡片里直接报错，而不是等到执行才失败。
 *
 * 变量：
 * - `name` 当前主干（前面的规则可能已改过）
 * - `ext` 当前扩展名（不含点）
 * - `original` 扫描时的原主干
 * - `dir` 所在目录名
 * - `modified` 修改时间（毫秒）
 * - `size` 字节数
 * - `u0`–`u9` 用户自定义文本（未设置为空串）
 *
 * 函数见 FUNCTIONS；字符串一律按码点处理（emoji 不会被切成两半）。
 */

import { formatStamp } from './vars';

export interface ScriptEnv {
  name: string;
  ext: string;
  original: string;
  dir: string;
  modified: number;
  size: number;
  users?: string[];
}

export type ScriptErrorCode =
  | 'empty'
  | 'tooLong'
  | 'syntax'
  | 'unknownVar'
  | 'unknownFunc'
  | 'arity'
  | 'badRegex'
  | 'badNumber';

export interface ScriptError {
  code: ScriptErrorCode;
  /** 1 基字符位置（仅 syntax/badRegex 有） */
  pos?: number;
  name?: string;
  need?: string;
  got?: number;
}

export type ScriptResult = { ok: true; value: string } | { ok: false; error: ScriptError };

const MAX_SOURCE = 600;
const MAX_TOKENS = 400;
const MAX_DEPTH = 24;

interface Token {
  kind: 'num' | 'str' | 'ident' | 'op';
  text: string;
  pos: number;
  value?: number;
}

function tokenize(src: string): { tokens?: Token[]; error?: ScriptError } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      let text = '';
      let closed = false;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
          const next = src[i + 1];
          if (next === undefined) break;
          if (next === 's') text += ' ';
          else if (next === 'n') text += '\n';
          else if (next === 't') text += '\t';
          else if (next === '\\' || next === '"' || next === "'") text += next;
          // 其余反斜杠序列原样保留，方便脚本里直接写正则 `"\d+"`
          else text += `\\${next}`;
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        text += c;
        i += 1;
      }
      if (!closed) return { error: { code: 'syntax', pos: start + 1 } };
      tokens.push({ kind: 'str', text, pos: start + 1, value: text.length });
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < src.length && src[i] >= '0' && src[i] <= '9') i += 1;
      const raw = src.slice(start, i);
      tokens.push({ kind: 'num', text: raw, pos: start + 1, value: Number(raw) });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i += 1;
      tokens.push({ kind: 'ident', text: src.slice(start, i), pos: start + 1 });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) {
      tokens.push({ kind: 'op', text: two, pos: i + 1 });
      i += 2;
      continue;
    }
    if ('+-*/%()<>,?!:'.includes(ch)) {
      tokens.push({ kind: 'op', text: ch, pos: i + 1 });
      i += 1;
      continue;
    }
    return { error: { code: 'syntax', pos: i + 1 } };
  }
  return { tokens };
}

type Expr =
  | { kind: 'lit'; value: string | number | boolean }
  | { kind: 'var'; name: string; pos: number }
  | { kind: 'call'; name: string; args: Expr[]; pos: number }
  | { kind: 'unary'; op: '-' | '!'; arg: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'ternary'; cond: Expr; yes: Expr; no: Expr };

const VARIABLES = new Set([
  'name', 'ext', 'original', 'dir', 'modified', 'size',
  ...Array.from({ length: 10 }, (_, i) => `u${i}`),
]);

interface FunctionSpec {
  min: number;
  max: number;
  run: (args: (string | number | boolean)[], env: ScriptEnv) => string | number | boolean;
}

function asString(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
}

function asNumber(value: string | number | boolean): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : 0;
}

function truthy(value: string | number | boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  return value !== '';
}

function chars(text: string): string[] {
  return Array.from(text);
}

function padTo(text: string, width: number, fill: string): string {
  const list = chars(text);
  const widthInt = Math.max(0, Math.min(255, Math.trunc(width)));
  if (list.length >= widthInt) return text;
  const fillChars = chars(fill || '0').slice(0, 1);
  if (!fillChars.length) fillChars.push('0');
  return fillChars[0].repeat(widthInt - list.length) + text;
}

const FUNCTIONS: Record<string, FunctionSpec> = {
  upper: { min: 1, max: 1, run: (a) => chars(asString(a[0])).map((c) => c.toUpperCase()).join('') },
  lower: { min: 1, max: 1, run: (a) => chars(asString(a[0])).map((c) => c.toLowerCase()).join('') },
  trim: { min: 1, max: 1, run: (a) => asString(a[0]).replace(/^[\s\u3000]+|[\s\u3000]+$/g, '') },
  len: { min: 1, max: 1, run: (a) => chars(asString(a[0])).length },
  contains: { min: 2, max: 2, run: (a) => asString(a[0]).includes(asString(a[1])) },
  startsWith: { min: 2, max: 2, run: (a) => asString(a[0]).startsWith(asString(a[1])) },
  endsWith: { min: 2, max: 2, run: (a) => asString(a[0]).endsWith(asString(a[1])) },
  replace: {
    min: 3, max: 3,
    run: (a) => asString(a[0]).split(asString(a[1])).join(asString(a[2])),
  },
  regex: {
    min: 3, max: 4,
    run: (a) => {
      const flags = a.length > 3 ? asString(a[3]).replace(/[^gimsuy]/g, '') : '';
      const re = new RegExp(asString(a[1]), flags.includes('g') ? flags : `g${flags}`);
      return asString(a[0]).replace(re, asString(a[2]));
    },
  },
  cut: {
    min: 3, max: 3,
    run: (a) => {
      const list = chars(asString(a[0]));
      const start = Math.max(1, Math.trunc(asNumber(a[1])));
      const count = Math.max(0, Math.trunc(asNumber(a[2])));
      return list.slice(start - 1, start - 1 + count).join('');
    },
  },
  pad: {
    min: 2, max: 3,
    run: (a) => padTo(asString(a[0]), asNumber(a[1]), a.length > 2 ? asString(a[2]) : '0'),
  },
  // if 的参数由求值器惰性处理，这里只为语法/参数个数校验占位
  if: { min: 3, max: 3, run: () => '' },
  date: { min: 0, max: 1, run: (a, env) => formatStamp(env.modified, a.length ? asString(a[0]) : 'yyyyMMdd') },
  time: { min: 0, max: 1, run: (a, env) => formatStamp(env.modified, a.length ? asString(a[0]) : 'HHmmss') },
};

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): { expr?: Expr; error?: ScriptError } {
    if (!this.tokens.length) return { error: { code: 'empty' } };
    const expr = this.ternary();
    if (expr.error) return expr as { error: ScriptError };
    if (this.index < this.tokens.length) {
      return { error: { code: 'syntax', pos: this.tokens[this.index].pos } };
    }
    return { expr: expr.expr };
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private eat(text: string): Token | undefined {
    const token = this.peek();
    if (token && token.kind === 'op' && token.text === text) {
      this.index += 1;
      return token;
    }
    return undefined;
  }

  private ternary(): { expr?: Expr; error?: ScriptError } {
    if (++this.depth > MAX_DEPTH) return { error: { code: 'syntax', pos: this.peek()?.pos ?? 1 } };
    const cond = this.or();
    if (cond.error) return cond;
    if (this.eat('?')) {
      const yes = this.ternary();
      if (yes.error) return yes;
      if (!this.eat(':')) return { error: { code: 'syntax', pos: this.peek()?.pos ?? 1 } };
      const no = this.ternary();
      if (no.error) return no;
      this.depth -= 1;
      return { expr: { kind: 'ternary', cond: cond.expr!, yes: yes.expr!, no: no.expr! } };
    }
    this.depth -= 1;
    return cond;
  }

  private or(): { expr?: Expr; error?: ScriptError } {
    let left = this.and();
    if (left.error) return left;
    while (this.eat('||')) {
      const right = this.and();
      if (right.error) return right;
      left = { expr: { kind: 'binary', op: '||', left: left.expr!, right: right.expr! } };
    }
    return left;
  }

  private and(): { expr?: Expr; error?: ScriptError } {
    let left = this.eq();
    if (left.error) return left;
    while (this.eat('&&')) {
      const right = this.eq();
      if (right.error) return right;
      left = { expr: { kind: 'binary', op: '&&', left: left.expr!, right: right.expr! } };
    }
    return left;
  }

  private eq(): { expr?: Expr; error?: ScriptError } {
    let left = this.rel();
    if (left.error) return left;
    let op = this.peek();
    while (op && op.kind === 'op' && (op.text === '==' || op.text === '!=')) {
      this.index += 1;
      const right = this.rel();
      if (right.error) return right;
      left = { expr: { kind: 'binary', op: op.text, left: left.expr!, right: right.expr! } };
      op = this.peek();
    }
    return left;
  }

  private rel(): { expr?: Expr; error?: ScriptError } {
    let left = this.concat();
    if (left.error) return left;
    let op = this.peek();
    while (op && op.kind === 'op' && ['<', '<=', '>', '>='].includes(op.text)) {
      this.index += 1;
      const right = this.concat();
      if (right.error) return right;
      left = { expr: { kind: 'binary', op: op.text, left: left.expr!, right: right.expr! } };
      op = this.peek();
    }
    return left;
  }

  private concat(): { expr?: Expr; error?: ScriptError } {
    let left = this.mul();
    if (left.error) return left;
    while (this.eat('+')) {
      const right = this.mul();
      if (right.error) return right;
      left = { expr: { kind: 'binary', op: '+', left: left.expr!, right: right.expr! } };
    }
    return left;
  }

  private mul(): { expr?: Expr; error?: ScriptError } {
    let left = this.unary();
    if (left.error) return left;
    let op = this.peek();
    while (op && op.kind === 'op' && (op.text === '*' || op.text === '/' || op.text === '%')) {
      this.index += 1;
      const right = this.unary();
      if (right.error) return right;
      left = { expr: { kind: 'binary', op: op.text, left: left.expr!, right: right.expr! } };
      op = this.peek();
    }
    return left;
  }

  private unary(): { expr?: Expr; error?: ScriptError } {
    const token = this.peek();
    if (token && token.kind === 'op' && (token.text === '-' || token.text === '!')) {
      this.index += 1;
      const arg = this.unary();
      if (arg.error) return arg;
      return { expr: { kind: 'unary', op: token.text as '-' | '!', arg: arg.expr! } };
    }
    return this.primary();
  }

  private primary(): { expr?: Expr; error?: ScriptError } {
    const token = this.peek();
    if (!token) return { error: { code: 'syntax', pos: 1 } };
    if (token.kind === 'num') {
      this.index += 1;
      return { expr: { kind: 'lit', value: token.value ?? 0 } };
    }
    if (token.kind === 'str') {
      this.index += 1;
      return { expr: { kind: 'lit', value: token.text } };
    }
    if (token.kind === 'ident') {
      this.index += 1;
      const name = token.text;
      if (name === 'true' || name === 'false') return { expr: { kind: 'lit', value: name === 'true' } };
      if (this.eat('(')) {
        const args: Expr[] = [];
        if (!this.eat(')')) {
          do {
            const arg = this.ternary();
            if (arg.error) return arg;
            args.push(arg.expr!);
          } while (this.eat(','));
          if (!this.eat(')')) return { error: { code: 'syntax', pos: this.peek()?.pos ?? token.pos } };
        }
        const spec = FUNCTIONS[name];
        if (!spec) return { error: { code: 'unknownFunc', name, pos: token.pos } };
        if (args.length < spec.min || args.length > spec.max) {
          return {
            error: {
              code: 'arity', name, got: args.length,
              need: spec.min === spec.max ? String(spec.min) : `${spec.min}-${spec.max}`,
              pos: token.pos,
            },
          };
        }
        if (name === 'regex' && args[1] && args[1].kind === 'lit' && typeof args[1].value === 'string') {
          try {
            new RegExp(args[1].value, args[3] && args[3].kind === 'lit' && typeof args[3].value === 'string' ? args[3].value : 'g');
          } catch {
            return { error: { code: 'badRegex', pos: token.pos } };
          }
        }
        return { expr: { kind: 'call', name, args, pos: token.pos } };
      }
      if (!VARIABLES.has(name)) return { error: { code: 'unknownVar', name, pos: token.pos } };
      return { expr: { kind: 'var', name, pos: token.pos } };
    }
    if (token.kind === 'op' && token.text === '(') {
      this.index += 1;
      const inner = this.ternary();
      if (inner.error) return inner;
      if (!this.eat(')')) return { error: { code: 'syntax', pos: this.peek()?.pos ?? token.pos } };
      return inner;
    }
    return { error: { code: 'syntax', pos: token.pos } };
  }
}

interface Compiled {
  expr?: Expr;
  error?: ScriptError;
}

const cache = new Map<string, Compiled>();

export function compileScript(source: string): Compiled {
  const src = source.trim();
  if (!src) return { error: { code: 'empty' } };
  if (src.length > MAX_SOURCE) return { error: { code: 'tooLong' } };
  const hit = cache.get(src);
  if (hit) return hit;
  const lexed = tokenize(src);
  let result: Compiled;
  if (!lexed.tokens) result = { error: lexed.error };
  else if (lexed.tokens.length > MAX_TOKENS) result = { error: { code: 'tooLong' } };
  else {
    const parsed = new Parser(lexed.tokens).parse();
    result = parsed.error ? { error: parsed.error } : { expr: parsed.expr };
  }
  if (cache.size >= 200) cache.clear();
  cache.set(src, result);
  return result;
}

function evaluate(node: Expr, env: ScriptEnv): string | number | boolean {
  switch (node.kind) {
    case 'lit':
      return node.value;
    case 'var': {
      switch (node.name) {
        case 'name': return env.name;
        case 'ext': return env.ext;
        case 'original': return env.original;
        case 'dir': return env.dir;
        case 'modified': return env.modified;
        case 'size': return env.size;
        default: return env.users?.[Number(node.name.slice(1))] ?? '';
      }
    }
    case 'unary': {
      const value = evaluate(node.arg, env);
      return node.op === '-' ? -asNumber(value) : !truthy(value);
    }
    case 'ternary':
      return truthy(evaluate(node.cond, env)) ? evaluate(node.yes, env) : evaluate(node.no, env);
    case 'binary': {
      if (node.op === '&&') {
        return truthy(evaluate(node.left, env)) && truthy(evaluate(node.right, env));
      }
      if (node.op === '||') {
        return truthy(evaluate(node.left, env)) || truthy(evaluate(node.right, env));
      }
      const left = evaluate(node.left, env);
      const right = evaluate(node.right, env);
      switch (node.op) {
        case '+':
          return typeof left === 'number' && typeof right === 'number'
            ? left + right
            : asString(left) + asString(right);
        case '-': return asNumber(left) - asNumber(right);
        case '*': return asNumber(left) * asNumber(right);
        case '/': {
          const divisor = asNumber(right);
          return divisor === 0 ? 0 : asNumber(left) / divisor;
        }
        case '%': {
          const divisor = asNumber(right);
          return divisor === 0 ? 0 : asNumber(left) % divisor;
        }
        case '==':
          return typeof left === typeof right ? left === right : asString(left) === asString(right);
        case '!=':
          return typeof left === typeof right ? left !== right : asString(left) !== asString(right);
        case '<':
        case '<=':
        case '>':
        case '>=': {
          if (typeof left === 'number' && typeof right === 'number') {
            if (node.op === '<') return left < right;
            if (node.op === '<=') return left <= right;
            if (node.op === '>') return left > right;
            return left >= right;
          }
          const a = asString(left);
          const b = asString(right);
          if (node.op === '<') return a < b;
          if (node.op === '<=') return a <= b;
          if (node.op === '>') return a > b;
          return a >= b;
        }
        default:
          return '';
      }
    }
    case 'call': {
      if (node.name === 'if') {
        return truthy(evaluate(node.args[0], env)) ? evaluate(node.args[1], env) : evaluate(node.args[2], env);
      }
      const spec = FUNCTIONS[node.name];
      const args = node.args.map((arg) => evaluate(arg, env));
      return spec.run(args, env);
    }
    default:
      return '';
  }
}

/** 求值：解析失败或结果非字符串/为空串都返回失败，让上层保持原名。 */
export function runScript(source: string, env: ScriptEnv): ScriptResult {
  const compiled = compileScript(source);
  if (compiled.error) return { ok: false, error: compiled.error };
  let value: string | number | boolean;
  try {
    value = evaluate(compiled.expr!, env);
  } catch {
    return { ok: false, error: { code: 'syntax', pos: 1 } };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { ok: false, error: { code: 'badNumber' } };
  }
  const text = asString(value);
  if (!text) return { ok: false, error: { code: 'empty' } };
  return { ok: true, value: text };
}
