// Just enough typing for the subset to keep mutations and refactors valid
// TypeScript: the type of an expression, and the variables in scope at each
// statement. A swap that would not type-check is never offered, so every
// buggy version still compiles, as real bugs that reach review do. Pure.

import type { Expr, Fn, Module, Stmt } from "./ast.ts";

/** A type's source text: `number`, `string[]`, `number | null`. */
export type TypeText = string;

export type Env = Map<string, TypeText>;

const STRING_RESULT = new Set([
  "join",
  "toUpperCase",
  "toLowerCase",
  "trim",
  "charAt",
  "repeat",
  "padStart",
]);
const BOOLEAN_RESULT = new Set(["includes", "startsWith", "endsWith"]);

export function typeOf(
  e: Expr,
  env: Env,
  fns: Map<string, Fn>,
): TypeText | undefined {
  switch (e.k) {
    case "num":
      return "number";
    case "str":
      return "string";
    case "bool":
      return "boolean";
    case "null":
      return "null";
    case "id":
      return e.name === "Infinity" || e.name === "NaN"
        ? "number"
        : env.get(e.name);
    case "arr": {
      const first = e.items[0];
      const t = first && typeOf(first, env, fns);
      return t ? `${t}[]` : undefined;
    }
    case "bin":
      if (["-", "*", "/", "%"].includes(e.op)) return "number";
      if (e.op === "+") {
        const l = typeOf(e.l, env, fns);
        const r = typeOf(e.r, env, fns);
        if (l === "string" || r === "string") return "string";
        return l === "number" && r === "number" ? "number" : undefined;
      }
      return "boolean";
    case "un":
      return e.op === "!" ? "boolean" : "number";
    case "cond":
      return typeOf(e.t, env, fns);
    case "idx": {
      const t = typeOf(e.obj, env, fns);
      if (t === "string") return "string";
      return t?.endsWith("[]") ? t.slice(0, -2) : undefined;
    }
    case "mem":
      return e.prop === "length" ? "number" : undefined;
    case "call": {
      const c = e.callee;
      if (c.k === "id") return fns.get(c.name)?.ret;
      if (c.k !== "mem") return undefined;
      if (c.obj.k === "id" && c.obj.name === "Math") return "number";
      const obj = typeOf(c.obj, env, fns);
      if (c.prop === "slice" || c.prop === "concat") return obj;
      if (c.prop === "indexOf" || c.prop === "push") return "number";
      if (c.prop === "split") return "string[]";
      if (STRING_RESULT.has(c.prop)) return "string";
      if (BOOLEAN_RESULT.has(c.prop)) return "boolean";
      return undefined;
    }
  }
}

export const fnTable = (m: Module): Map<string, Fn> =>
  new Map(m.fns.map((f) => [f.name, f]));

/**
 * Visits every statement of `fn` in source order with the variables in
 * scope before it runs (parameters, earlier declarations of enclosing
 * blocks, loop variables), and the list that holds it.
 */
export function walkScoped(
  fn: Fn,
  fns: Map<string, Fn>,
  visit: (s: Stmt, env: Env, list: Stmt[], index: number) => void,
): void {
  const declare = (s: Stmt, env: Env) => {
    if (s.k === "let") {
      const t = s.type ?? typeOf(s.init, env, fns);
      if (t) env.set(s.name, t);
    }
  };
  const walk = (body: Stmt[], outer: Env) => {
    const env: Env = new Map(outer);
    body.forEach((s, i) => {
      visit(s, env, body, i);
      switch (s.k) {
        case "if":
          walk(s.consequent, env);
          if (s.else) walk(s.else, env);
          break;
        case "while":
          walk(s.body, env);
          break;
        case "for": {
          const inner: Env = new Map(env);
          declare(s.init, inner);
          walk(s.body, inner);
          break;
        }
        case "forof": {
          const inner: Env = new Map(env);
          const t = typeOf(s.iter, env, fns);
          const el =
            t === "string"
              ? "string"
              : t?.endsWith("[]")
                ? t.slice(0, -2)
                : undefined;
          if (el) inner.set(s.name, el);
          walk(s.body, inner);
          break;
        }
        default:
          break;
      }
      declare(s, env);
    });
  };
  walk(fn.body, new Map(fn.params.map((p) => [p.name, p.type])));
}

/** The environment a `for` statement's own header and body see. */
export function loopEnv(
  s: Stmt & { k: "for" | "forof" },
  env: Env,
  fns: Map<string, Fn>,
): Env {
  const inner: Env = new Map(env);
  if (s.k === "for" && s.init.k === "let") {
    const t = s.init.type ?? typeOf(s.init.init, env, fns);
    if (t) inner.set(s.init.name, t);
  }
  if (s.k === "forof") {
    const t = typeOf(s.iter, env, fns);
    const el =
      t === "string"
        ? "string"
        : t?.endsWith("[]")
          ? t.slice(0, -2)
          : undefined;
    if (el) inner.set(s.name, el);
  }
  return inner;
}
