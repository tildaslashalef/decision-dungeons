// Runs the subset with JavaScript's semantics: values are plain JS values
// and every operator is JS's own, so `"a" + 1`, an index past the end, and
// `NaN` behave exactly as in the printed TypeScript. A step budget turns a
// loop that never ends into a `timeout` instead of a hang; a throw keeps
// the frames it passed through, for a stack trace. Pure and deterministic.

import type { Expr, Fn, Module, Stmt } from "./ast.ts";
import { printExpr } from "./print.ts";

export type Value = number | string | boolean | null | undefined | Value[];

export interface Frame {
  fn: string;
  stmt: Stmt;
}

export type Outcome =
  | { kind: "value"; value: Value }
  | { kind: "throw"; error: string; frames: Frame[] }
  | { kind: "timeout" };

/** Statements a call may execute before it counts as never ending. */
export const STEP_BUDGET = 20_000;
/** Nested calls before a call counts as never ending. */
const DEPTH_LIMIT = 64;

class Thrown {
  constructor(
    readonly error: string,
    readonly frames: Frame[],
  ) {}
}
class OutOfSteps {}

type Signal =
  | undefined
  | { k: "return"; value: Value }
  | { k: "break" }
  | { k: "continue" };

class Scope {
  private vars = new Map<string, Value>();
  constructor(private readonly parent?: Scope) {}
  declare(name: string, value: Value) {
    this.vars.set(name, value);
  }
  get(name: string): Value {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    throw new Error(`${name} is not defined`);
  }
  set(name: string, value: Value) {
    if (this.vars.has(name)) this.vars.set(name, value);
    else if (this.parent) this.parent.set(name, value);
    else throw new Error(`${name} is not defined`);
  }
}

const MATH: Record<string, (...a: number[]) => number> = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  trunc: Math.trunc,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  sqrt: Math.sqrt,
};

const ARRAY_METHODS = new Set([
  "push",
  "slice",
  "includes",
  "indexOf",
  "join",
  "concat",
  "reverse",
]);
const STRING_METHODS = new Set([
  "slice",
  "includes",
  "indexOf",
  "toUpperCase",
  "toLowerCase",
  "trim",
  "split",
  "startsWith",
  "endsWith",
  "charAt",
  "repeat",
  "padStart",
]);

const kindOf = (v: Value) =>
  v === null ? "null" : v === undefined ? "undefined" : typeof v;

class Machine {
  private steps = 0;
  private readonly stack: Frame[] = [];
  private readonly fns: Map<string, Fn>;

  constructor(module: Module) {
    this.fns = new Map(module.fns.map((f) => [f.name, f]));
  }

  private tick() {
    if (++this.steps > STEP_BUDGET) throw new OutOfSteps();
  }

  private fail(error: string): never {
    throw new Thrown(
      error,
      this.stack.map((f) => ({ ...f })),
    );
  }

  private readProp(obj: Value, prop: string): never {
    this.fail(
      `TypeError: Cannot read properties of ${kindOf(obj)} (reading '${prop}')`,
    );
  }

  call(name: string, args: Value[]): Value {
    const fn = this.fns.get(name);
    if (!fn) this.fail(`ReferenceError: ${name} is not defined`);
    if (this.stack.length >= DEPTH_LIMIT) throw new OutOfSteps();
    const scope = new Scope();
    fn.params.forEach((p, i) => {
      scope.declare(p.name, args[i]);
    });
    this.stack.push({ fn: fn.name, stmt: fn.body[0] as Stmt });
    const signal = this.block(fn.body, scope);
    this.stack.pop();
    return signal?.k === "return" ? signal.value : undefined;
  }

  private block(body: Stmt[], parent: Scope): Signal {
    const scope = new Scope(parent);
    for (const s of body) {
      const signal = this.stmt(s, scope);
      if (signal) return signal;
    }
    return undefined;
  }

  private assignTo(target: Expr, value: Value, scope: Scope) {
    if (target.k === "id") scope.set(target.name, value);
    else if (target.k === "idx") {
      const obj = this.expr(target.obj, scope);
      const index = this.expr(target.index, scope);
      if (!Array.isArray(obj)) {
        if (obj === null || obj === undefined)
          this.fail(
            `TypeError: Cannot set properties of ${kindOf(obj)} (setting '${String(index)}')`,
          );
        return; // Writing an index of a string is silently ignored, as in JS.
      }
      obj[index as number] = value;
    } else throw new Error(`cannot assign to ${printExpr(target)}`);
  }

  private stmt(s: Stmt, scope: Scope): Signal {
    this.tick();
    const frame = this.stack[this.stack.length - 1];
    if (frame) frame.stmt = s;
    switch (s.k) {
      case "let":
        scope.declare(s.name, this.expr(s.init, scope));
        return undefined;
      case "assign": {
        const value = this.expr(s.value, scope);
        if (s.op === "=") {
          this.assignTo(s.target, value, scope);
          return undefined;
        }
        const old = this.expr(s.target, scope) as number;
        const v = value as number;
        this.assignTo(
          s.target,
          s.op === "+=" ? old + v : s.op === "-=" ? old - v : old * v,
          scope,
        );
        return undefined;
      }
      case "inc": {
        const old = this.expr(s.target, scope) as number;
        this.assignTo(s.target, s.op === "++" ? old + 1 : old - 1, scope);
        return undefined;
      }
      case "expr":
        this.expr(s.e, scope);
        return undefined;
      case "if":
        if (this.expr(s.c, scope)) return this.block(s.consequent, scope);
        return s.else ? this.block(s.else, scope) : undefined;
      case "while":
        while (this.expr(s.c, scope)) {
          this.tick();
          const signal = this.block(s.body, scope);
          if (signal?.k === "break") break;
          if (signal?.k === "return") return signal;
        }
        return undefined;
      case "for": {
        const loop = new Scope(scope);
        this.stmt(s.init, loop);
        while (this.expr(s.test, loop)) {
          this.tick();
          const signal = this.block(s.body, loop);
          if (signal?.k === "break") break;
          if (signal?.k === "return") return signal;
          this.stmt(s.update, loop);
        }
        return undefined;
      }
      case "forof": {
        const iter = this.expr(s.iter, scope);
        if (iter === null || iter === undefined)
          this.fail(`TypeError: ${kindOf(iter)} is not iterable`);
        if (typeof iter === "string") {
          for (const ch of iter) {
            this.tick();
            const loop = new Scope(scope);
            loop.declare(s.name, ch);
            const signal = this.block(s.body, loop);
            if (signal?.k === "break") break;
            if (signal?.k === "return") return signal;
          }
          return undefined;
        }
        if (!Array.isArray(iter))
          this.fail(`TypeError: ${printExpr(s.iter)} is not iterable`);
        // The array is read live, as JS's iterator reads it.
        for (let i = 0; i < iter.length; i++) {
          this.tick();
          const loop = new Scope(scope);
          loop.declare(s.name, iter[i]);
          const signal = this.block(s.body, loop);
          if (signal?.k === "break") break;
          if (signal?.k === "return") return signal;
        }
        return undefined;
      }
      case "return":
        return { k: "return", value: s.e ? this.expr(s.e, scope) : undefined };
      case "break":
        return { k: "break" };
      case "continue":
        return { k: "continue" };
      case "throw":
        this.fail(`Error: ${String(this.expr(s.message, scope))}`);
    }
  }

  private expr(e: Expr, scope: Scope): Value {
    switch (e.k) {
      case "num":
      case "str":
      case "bool":
        return e.v;
      case "null":
        return null;
      case "id":
        if (e.name === "Infinity") return Number.POSITIVE_INFINITY;
        if (e.name === "NaN") return Number.NaN;
        return scope.get(e.name);
      case "arr":
        return e.items.map((i) => this.expr(i, scope));
      case "un": {
        const v = this.expr(e.e, scope);
        return e.op === "!" ? !v : -(v as number);
      }
      case "cond":
        return this.expr(e.c, scope)
          ? this.expr(e.t, scope)
          : this.expr(e.f, scope);
      case "bin": {
        if (e.op === "&&") {
          const l = this.expr(e.l, scope);
          return l ? this.expr(e.r, scope) : l;
        }
        if (e.op === "||") {
          const l = this.expr(e.l, scope);
          return l ? l : this.expr(e.r, scope);
        }
        // Casts only satisfy the checker: JS applies its own coercions.
        const l = this.expr(e.l, scope) as number;
        const r = this.expr(e.r, scope) as number;
        switch (e.op) {
          case "+":
            return l + r;
          case "-":
            return l - r;
          case "*":
            return l * r;
          case "/":
            return l / r;
          case "%":
            return l % r;
          case "<":
            return l < r;
          case "<=":
            return l <= r;
          case ">":
            return l > r;
          case ">=":
            return l >= r;
          case "===":
            return l === r;
          case "!==":
            return l !== r;
        }
        return undefined;
      }
      case "idx": {
        const obj = this.expr(e.obj, scope);
        const index = this.expr(e.index, scope);
        if (obj === null || obj === undefined)
          this.readProp(obj, String(index));
        if (Array.isArray(obj) || typeof obj === "string")
          return obj[index as number];
        return undefined;
      }
      case "mem": {
        const obj = this.expr(e.obj, scope);
        if (obj === null || obj === undefined) this.readProp(obj, e.prop);
        if (e.prop !== "length")
          throw new Error(`unsupported property .${e.prop}`);
        return Array.isArray(obj) || typeof obj === "string"
          ? obj.length
          : undefined;
      }
      case "call":
        return this.callExpr(e, scope);
    }
  }

  private callExpr(e: Expr & { k: "call" }, scope: Scope): Value {
    const callee = e.callee;
    if (callee.k === "id") {
      const args = e.args.map((a) => this.expr(a, scope));
      return this.call(callee.name, args);
    }
    if (callee.k !== "mem")
      throw new Error(`unsupported call ${printExpr(callee)}`);
    if (callee.obj.k === "id" && callee.obj.name === "Math") {
      const f = MATH[callee.prop];
      if (!f) throw new Error(`unsupported Math.${callee.prop}`);
      return f(...e.args.map((a) => this.expr(a, scope) as number));
    }
    const obj = this.expr(callee.obj, scope);
    if (obj === null || obj === undefined) this.readProp(obj, callee.prop);
    const allowed = Array.isArray(obj)
      ? ARRAY_METHODS
      : typeof obj === "string"
        ? STRING_METHODS
        : undefined;
    if (!allowed?.has(callee.prop))
      this.fail(`TypeError: ${printExpr(callee)} is not a function`);
    const args = e.args.map((a) => this.expr(a, scope));
    const method = Reflect.get(Object(obj), callee.prop) as (
      ...a: Value[]
    ) => Value;
    return method.apply(obj, args);
  }
}

/** A deep copy of a value, so each call gets inputs no other call has touched. */
export const copyValue = (v: Value): Value =>
  Array.isArray(v) ? v.map(copyValue) : v;

/** Calls `name` in `module` with copies of `args`. */
export function runCall(module: Module, name: string, args: Value[]): Outcome {
  const m = new Machine(module);
  try {
    return { kind: "value", value: m.call(name, args.map(copyValue)) };
  } catch (error) {
    if (error instanceof Thrown)
      return { kind: "throw", error: error.error, frames: error.frames };
    if (error instanceof OutOfSteps) return { kind: "timeout" };
    throw error;
  }
}

/** A value as a TypeScript literal: `[1, 2]`, `"ab"`, `NaN`, `undefined`. */
export function showValue(v: Value): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(showValue).join(", ")}]`;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" && Object.is(v, -0)) return "0";
  return String(v);
}

/** An outcome as a person reads it: the value, the error thrown, or that it never returned. */
export function showOutcome(o: Outcome): string {
  if (o.kind === "value") return showValue(o.value);
  if (o.kind === "throw") return `throws ${o.error}`;
  return "never returns (timed out)";
}

/** Whether two outcomes count as the same result: equal values, or the same error, or both time out. */
export const sameOutcome = (a: Outcome, b: Outcome): boolean =>
  showOutcome(a) === showOutcome(b);
