// The TypeScript subset the code dungeons write, run, and change: plain
// functions over numbers, strings, booleans, and arrays of them. Small
// enough to interpret exactly, large enough to read as everyday code.
// Types are kept as their source text: the interpreter ignores them and
// the printer writes them back. Pure: the browser imports it.

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<"
  | "<="
  | ">"
  | ">="
  | "==="
  | "!=="
  | "&&"
  | "||";

export type Expr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "id"; name: string }
  | { k: "arr"; items: Expr[] }
  | { k: "bin"; op: BinaryOp; l: Expr; r: Expr }
  | { k: "un"; op: "!" | "-"; e: Expr }
  | { k: "cond"; c: Expr; t: Expr; f: Expr }
  | { k: "idx"; obj: Expr; index: Expr }
  | { k: "mem"; obj: Expr; prop: string }
  | { k: "call"; callee: Expr; args: Expr[] };

export type AssignOp = "=" | "+=" | "-=" | "*=";

export type Stmt =
  | {
      k: "let";
      kind: "const" | "let";
      name: string;
      type?: string;
      init: Expr;
    }
  | { k: "assign"; target: Expr; op: AssignOp; value: Expr }
  | { k: "inc"; target: Expr; op: "++" | "--" }
  | { k: "expr"; e: Expr }
  | { k: "if"; c: Expr; consequent: Stmt[]; else?: Stmt[] }
  | { k: "for"; init: Stmt; test: Expr; update: Stmt; body: Stmt[] }
  | { k: "forof"; name: string; iter: Expr; body: Stmt[] }
  | { k: "while"; c: Expr; body: Stmt[] }
  | { k: "return"; e?: Expr }
  | { k: "break" }
  | { k: "continue" }
  | { k: "throw"; message: Expr };

export interface Param {
  name: string;
  type: string;
}

export interface Fn {
  name: string;
  params: Param[];
  ret: string;
  body: Stmt[];
}

/** A file: functions in order; the last is the one a template exports. */
export interface Module {
  fns: Fn[];
}

/** A deep copy: mutations and refactors change copies, never the original. */
export const cloneModule = (m: Module): Module => structuredClone(m);

/** Every statement list in a statement, the statement's own blocks. */
export function blocks(s: Stmt): Stmt[][] {
  switch (s.k) {
    case "if":
      return s.else ? [s.consequent, s.else] : [s.consequent];
    case "for":
    case "forof":
    case "while":
      return [s.body];
    default:
      return [];
  }
}

/** Visits every statement, depth first in source order, with the list that holds it. */
export function eachStmt(
  body: Stmt[],
  visit: (s: Stmt, list: Stmt[], index: number) => void,
): void {
  for (let i = 0; i < body.length; i++) {
    const s = body[i] as Stmt;
    visit(s, body, i);
    for (const b of blocks(s)) eachStmt(b, visit);
  }
}

/** The expressions a statement holds directly (not those of nested statements). */
export function stmtExprs(s: Stmt): Expr[] {
  switch (s.k) {
    case "let":
      return [s.init];
    case "assign":
      return [s.target, s.value];
    case "inc":
      return [s.target];
    case "expr":
      return [s.e];
    case "if":
    case "while":
      return [s.c];
    case "for":
      return [s.test];
    case "forof":
      return [s.iter];
    case "return":
      return s.e ? [s.e] : [];
    case "throw":
      return [s.message];
    default:
      return [];
  }
}

/** Sub-expressions of an expression, in source order. */
export function children(e: Expr): Expr[] {
  switch (e.k) {
    case "arr":
      return e.items;
    case "bin":
      return [e.l, e.r];
    case "un":
      return [e.e];
    case "cond":
      return [e.c, e.t, e.f];
    case "idx":
      return [e.obj, e.index];
    case "mem":
      return [e.obj];
    case "call":
      return [e.callee, ...e.args];
    default:
      return [];
  }
}

/** Visits an expression and every sub-expression, parents first. */
export function eachExpr(e: Expr, visit: (e: Expr) => void): void {
  visit(e);
  for (const c of children(e)) eachExpr(c, visit);
}

/** Overwrites `target` in place with a copy of `value`, keeping references to it valid. */
export function overwrite<T extends Expr | Stmt>(target: T, value: T): void {
  const copy = structuredClone(value);
  for (const key of Object.keys(target))
    delete (target as Record<string, unknown>)[key];
  Object.assign(target, copy);
}

/** Overwrites the expression `target` in place with `value`. */
export const replaceExpr = (target: Expr, value: Expr): void =>
  overwrite(target, value);
