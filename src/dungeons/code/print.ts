// Prints the subset as canonical TypeScript (two-space indent, double
// quotes, the fewest parentheses that keep the meaning) and records the line
// each statement starts on, which is how "which line holds the bug" gets
// its answer. Printing then parsing gives back the same tree. Pure.

import type { Expr, Fn, Module, Stmt } from "./ast.ts";

const PREC: Record<string, number> = {
  "||": 2,
  "&&": 3,
  "===": 4,
  "!==": 4,
  "<": 5,
  "<=": 5,
  ">": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  "%": 7,
};

function precOf(e: Expr): number {
  switch (e.k) {
    case "cond":
      return 1;
    case "bin":
      return PREC[e.op] ?? 0;
    case "un":
      return 8;
    case "num":
      return e.v < 0 || Object.is(e.v, -0) ? 8 : 10;
    case "idx":
    case "mem":
    case "call":
      return 9;
    default:
      return 10;
  }
}

const quote = (s: string) => JSON.stringify(s);

const num = (v: number) => (Object.is(v, -0) ? "-0" : String(v));

export function printExpr(e: Expr): string {
  const wrap = (child: Expr, min: number) => {
    const text = printExpr(child);
    return precOf(child) < min ? `(${text})` : text;
  };
  switch (e.k) {
    case "num":
      return num(e.v);
    case "str":
      return quote(e.v);
    case "bool":
      return String(e.v);
    case "null":
      return "null";
    case "id":
      return e.name;
    case "arr":
      return `[${e.items.map(printExpr).join(", ")}]`;
    case "bin": {
      const p = PREC[e.op] ?? 0;
      return `${wrap(e.l, p)} ${e.op} ${wrap(e.r, p + 1)}`;
    }
    case "un": {
      // `- -x` and `-(-1)` must not print as a decrement.
      const inner = wrap(e.e, 8);
      return e.op === "-" && inner.startsWith("-")
        ? `-(${inner})`
        : `${e.op}${inner}`;
    }
    case "cond":
      return `${wrap(e.c, 2)} ? ${wrap(e.t, 1)} : ${wrap(e.f, 1)}`;
    case "idx":
      return `${wrap(e.obj, 9)}[${printExpr(e.index)}]`;
    case "mem":
      return `${wrap(e.obj, 9)}.${e.prop}`;
    case "call":
      return `${wrap(e.callee, 9)}(${e.args.map(printExpr).join(", ")})`;
  }
}

/** A statement on one line, as it appears in a `for` header. */
function inline(s: Stmt): string {
  switch (s.k) {
    case "let":
      return `${s.kind} ${s.name}${s.type ? `: ${s.type}` : ""} = ${printExpr(s.init)}`;
    case "assign":
      return `${printExpr(s.target)} ${s.op} ${printExpr(s.value)}`;
    case "inc":
      return `${printExpr(s.target)}${s.op}`;
    case "expr":
      return printExpr(s.e);
    default:
      throw new Error(`a ${s.k} statement cannot be inlined`);
  }
}

export interface Printed {
  text: string;
  /** The file's lines, without line breaks. */
  lines: string[];
  /** The 1-based line each statement starts on. */
  lineOf: Map<Stmt, number>;
  /** Each function's first and last line, 1-based, by name. */
  span: Map<string, { from: number; to: number }>;
}

class Writer {
  lines: string[] = [];
  lineOf = new Map<Stmt, number>();
  span = new Map<string, { from: number; to: number }>();

  private put(depth: number, text: string) {
    this.lines.push(`${"  ".repeat(depth)}${text}`);
  }

  block(body: Stmt[], depth: number) {
    for (const s of body) this.stmt(s, depth);
  }

  stmt(s: Stmt, depth: number, prefix = "") {
    this.lineOf.set(s, this.lines.length + 1);
    switch (s.k) {
      case "let":
      case "assign":
      case "inc":
      case "expr":
        this.put(depth, `${inline(s)};`);
        return;
      case "return":
        this.put(depth, s.e ? `return ${printExpr(s.e)};` : "return;");
        return;
      case "break":
      case "continue":
        this.put(depth, `${s.k};`);
        return;
      case "throw":
        this.put(depth, `throw new Error(${printExpr(s.message)});`);
        return;
      case "while":
        this.put(depth, `while (${printExpr(s.c)}) {`);
        this.block(s.body, depth + 1);
        this.put(depth, "}");
        return;
      case "forof":
        this.put(depth, `for (const ${s.name} of ${printExpr(s.iter)}) {`);
        this.block(s.body, depth + 1);
        this.put(depth, "}");
        return;
      case "for":
        this.put(
          depth,
          `for (${inline(s.init)}; ${printExpr(s.test)}; ${inline(s.update)}) {`,
        );
        this.block(s.body, depth + 1);
        this.put(depth, "}");
        return;
      case "if": {
        const head = `${prefix}if (${printExpr(s.c)}) {`;
        if (prefix) {
          // Continues the closing brace line of the `if` before it.
          this.lineOf.set(s, this.lines.length);
          this.lines[this.lines.length - 1] =
            `${this.lines[this.lines.length - 1]}${head.slice(1)}`;
        } else this.put(depth, head);
        this.block(s.consequent, depth + 1);
        if (!s.else) {
          this.put(depth, "}");
          return;
        }
        const only = s.else.length === 1 ? s.else[0] : undefined;
        if (only?.k === "if") {
          this.put(depth, "}");
          this.stmt(only, depth, " else ");
          return;
        }
        this.put(depth, "} else {");
        this.block(s.else, depth + 1);
        this.put(depth, "}");
        return;
      }
    }
  }

  fn(f: Fn, exported: boolean) {
    const from = this.lines.length + 1;
    const params = f.params.map((p) => `${p.name}: ${p.type}`).join(", ");
    this.put(
      0,
      `${exported ? "export " : ""}function ${f.name}(${params}): ${f.ret} {`,
    );
    this.block(f.body, 1);
    this.put(0, "}");
    this.span.set(f.name, { from, to: this.lines.length });
  }
}

/**
 * Prints a module; `exported` names the functions written with `export`
 * (absent: only the last, the one a template is about).
 */
export function printModule(m: Module, exported?: Set<string>): Printed {
  const w = new Writer();
  m.fns.forEach((f, i) => {
    if (i > 0) w.lines.push("");
    w.fn(f, exported ? exported.has(f.name) : i === m.fns.length - 1);
  });
  return {
    text: `${w.lines.join("\n")}\n`,
    lines: w.lines,
    lineOf: w.lineOf,
    span: w.span,
  };
}
