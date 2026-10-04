// A recursive-descent parser for the code dungeons' TypeScript subset, so
// templates are written as the TypeScript they print. It accepts only what
// `ast.ts` can hold and throws on anything else: a template that fails to
// parse is a bug in the template, caught by the tests. Pure.

import type { BinaryOp, Expr, Fn, Module, Param, Stmt } from "./ast.ts";

type Token =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const PUNCT = [
  "===",
  "!==",
  "<=",
  ">=",
  "&&",
  "||",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ",",
  ";",
  ":",
  ".",
  "?",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "=",
  "|",
];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (src.startsWith("//", i)) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i)) as RegExpExecArray;
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(
        src.slice(i),
      ) as RegExpExecArray;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") {
          const n = src[j + 1];
          v += n === "n" ? "\n" : n === "t" ? "\t" : (n ?? "");
          j += 2;
        } else v += src[j++];
      }
      if (src[j] !== '"') throw new Error("unterminated string");
      out.push({ t: "str", v });
      i = j + 1;
      continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (!p) throw new Error(`unexpected character ${ch} at ${i}`);
    out.push({ t: "op", v: p });
    i += p.length;
  }
  return out;
}

const REL: BinaryOp[] = ["<", "<=", ">", ">="];

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }
  private is(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return !!t && (t.t === "op" || t.t === "id") && t.v === v;
  }
  private eat(v: string): void {
    if (!this.is(v))
      throw new Error(
        `expected ${v}, found ${JSON.stringify(this.peek() ?? "end")}`,
      );
    this.i++;
  }
  private ident(): string {
    const t = this.peek();
    if (t?.t !== "id") throw new Error(`expected a name, found ${t?.v}`);
    this.i++;
    return t.v;
  }
  done(): boolean {
    return this.i >= this.tokens.length;
  }

  /** A type's source text, up to (not including) one of `stops` at depth zero. */
  private type(stops: string[]): string {
    let text = "";
    let depth = 0;
    while (!this.done()) {
      const t = this.peek() as Token;
      if (depth === 0 && t.t === "op" && stops.includes(t.v)) break;
      if (t.v === "[" || t.v === "(") depth++;
      if (t.v === "]" || t.v === ")") depth--;
      text += t.v === "|" ? " | " : String(t.v);
      this.i++;
    }
    if (!text) throw new Error("expected a type");
    return text;
  }

  fn(): Fn {
    if (this.is("export")) this.i++;
    this.eat("function");
    const name = this.ident();
    this.eat("(");
    const params: Param[] = [];
    while (!this.is(")")) {
      const pname = this.ident();
      this.eat(":");
      params.push({ name: pname, type: this.type([",", ")"]) });
      if (this.is(",")) this.i++;
    }
    this.eat(")");
    this.eat(":");
    const ret = this.type(["{"]);
    return { name, params, ret, body: this.block() };
  }

  private block(): Stmt[] {
    this.eat("{");
    const body: Stmt[] = [];
    while (!this.is("}")) body.push(this.stmt());
    this.eat("}");
    return body;
  }

  private decl(): Stmt {
    const kind = this.is("const") ? "const" : "let";
    this.i++;
    const name = this.ident();
    let type: string | undefined;
    if (this.is(":")) {
      this.i++;
      type = this.type(["="]);
    }
    this.eat("=");
    const init = this.expr();
    return type === undefined
      ? { k: "let", kind, name, init }
      : { k: "let", kind, name, type, init };
  }

  /** An assignment, increment, or expression, without its semicolon. */
  private simple(): Stmt {
    const e = this.expr();
    if (this.is("++") || this.is("--")) {
      const op = (this.peek() as Token).v as "++" | "--";
      this.i++;
      return { k: "inc", target: e, op };
    }
    for (const op of ["=", "+=", "-=", "*="] as const)
      if (this.is(op)) {
        this.i++;
        return { k: "assign", target: e, op, value: this.expr() };
      }
    return { k: "expr", e };
  }

  stmt(): Stmt {
    if (this.is("const") || this.is("let")) {
      const s = this.decl();
      this.eat(";");
      return s;
    }
    if (this.is("if")) {
      this.i++;
      this.eat("(");
      const c = this.expr();
      this.eat(")");
      const consequent = this.block();
      if (!this.is("else")) return { k: "if", c, consequent };
      this.i++;
      const otherwise = this.is("if") ? [this.stmt()] : this.block();
      return { k: "if", c, consequent, else: otherwise };
    }
    if (this.is("for")) {
      this.i++;
      this.eat("(");
      if (this.is("const") && this.is("of", 2)) {
        this.i++;
        const name = this.ident();
        this.eat("of");
        const iter = this.expr();
        this.eat(")");
        return { k: "forof", name, iter, body: this.block() };
      }
      const init = this.decl();
      this.eat(";");
      const test = this.expr();
      this.eat(";");
      const update = this.simple();
      this.eat(")");
      return { k: "for", init, test, update, body: this.block() };
    }
    if (this.is("while")) {
      this.i++;
      this.eat("(");
      const c = this.expr();
      this.eat(")");
      return { k: "while", c, body: this.block() };
    }
    if (this.is("return")) {
      this.i++;
      if (this.is(";")) {
        this.i++;
        return { k: "return" };
      }
      const e = this.expr();
      this.eat(";");
      return { k: "return", e };
    }
    if (this.is("break") || this.is("continue")) {
      const k = this.is("break") ? "break" : "continue";
      this.i++;
      this.eat(";");
      return { k };
    }
    if (this.is("throw")) {
      this.i++;
      this.eat("new");
      this.eat("Error");
      this.eat("(");
      const message = this.expr();
      this.eat(")");
      this.eat(";");
      return { k: "throw", message };
    }
    const s = this.simple();
    this.eat(";");
    return s;
  }

  expr(): Expr {
    const c = this.binary(0);
    if (!this.is("?")) return c;
    this.i++;
    const t = this.expr();
    this.eat(":");
    return { k: "cond", c, t, f: this.expr() };
  }

  private static readonly LEVELS: BinaryOp[][] = [
    ["||"],
    ["&&"],
    ["===", "!=="],
    REL,
    ["+", "-"],
    ["*", "/", "%"],
  ];

  private binary(level: number): Expr {
    const ops = Parser.LEVELS[level];
    if (!ops) return this.unary();
    let l = this.binary(level + 1);
    for (;;) {
      const op = ops.find((o) => this.is(o));
      if (!op) return l;
      this.i++;
      l = { k: "bin", op, l, r: this.binary(level + 1) };
    }
  }

  private unary(): Expr {
    if (this.is("!")) {
      this.i++;
      return { k: "un", op: "!", e: this.unary() };
    }
    if (this.is("-")) {
      this.i++;
      const e = this.unary();
      return e.k === "num" ? { k: "num", v: -e.v } : { k: "un", op: "-", e };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.is("(")) {
        this.i++;
        const args: Expr[] = [];
        while (!this.is(")")) {
          args.push(this.expr());
          if (this.is(",")) this.i++;
        }
        this.eat(")");
        e = { k: "call", callee: e, args };
      } else if (this.is("[")) {
        this.i++;
        const index = this.expr();
        this.eat("]");
        e = { k: "idx", obj: e, index };
      } else if (this.is(".")) {
        this.i++;
        e = { k: "mem", obj: e, prop: this.ident() };
      } else return e;
    }
  }

  private primary(): Expr {
    const t = this.peek();
    if (!t) throw new Error("unexpected end");
    if (t.t === "num") {
      this.i++;
      return { k: "num", v: t.v };
    }
    if (t.t === "str") {
      this.i++;
      return { k: "str", v: t.v };
    }
    if (t.t === "id") {
      this.i++;
      if (t.v === "true" || t.v === "false")
        return { k: "bool", v: t.v === "true" };
      if (t.v === "null") return { k: "null" };
      return { k: "id", name: t.v };
    }
    if (t.v === "(") {
      this.i++;
      const e = this.expr();
      this.eat(")");
      return e;
    }
    if (t.v === "[") {
      this.i++;
      const items: Expr[] = [];
      while (!this.is("]")) {
        items.push(this.expr());
        if (this.is(",")) this.i++;
      }
      this.eat("]");
      return { k: "arr", items };
    }
    throw new Error(`unexpected ${t.v}`);
  }
}

/** Parses a file of functions. */
export function parseModule(src: string): Module {
  const p = new Parser(tokenize(src));
  const fns: Fn[] = [];
  while (!p.done()) fns.push(p.fn());
  if (!fns.length) throw new Error("no function in the source");
  return { fns };
}

/** Parses one expression, for tests and inputs. */
export function parseExpr(src: string): Expr {
  const p = new Parser(tokenize(src));
  const e = p.expr();
  if (!p.done()) throw new Error("trailing tokens after the expression");
  return e;
}
