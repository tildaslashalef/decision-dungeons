// Mutation operators: the small slips that make real bugs, each tagged with
// the class of bug it makes. Sites are enumerated in a fixed order on a
// module; a mutant is a copy with one site applied. A mutant is not yet a
// bug: `differs` must find an input on which it behaves differently from
// the original, and the generators drop the mutants it cannot. Pure.

import {
  type BinaryOp,
  cloneModule,
  type Expr,
  type Module,
  replaceExpr,
  type Stmt,
  stmtExprs,
} from "./ast.ts";
import { type Outcome, runCall, sameOutcome, type Value } from "./interp.ts";
import { printExpr } from "./print.ts";
import { type Env, fnTable, loopEnv, typeOf, walkScoped } from "./types.ts";

export type BugClass =
  | "off-by-one"
  | "wrong-operator"
  | "inverted-condition"
  | "wrong-variable"
  | "missing-guard"
  | "missing-update";

/** Each class as a choice option describes it. */
export const BUG_CLASSES: Record<BugClass, string> = {
  "off-by-one":
    "a boundary is off by one: < where <= belongs (or the reverse), a start or end index one too far or too short",
  "wrong-operator":
    "the wrong operator: + for -, * for /, && for ||, < for >, Math.min for Math.max",
  "inverted-condition":
    "a condition tests the opposite of what it should: === for !==, a missing or extra !",
  "wrong-variable":
    "the wrong variable: another variable of the same type used where this one belongs",
  "missing-guard":
    "a guard is missing: the early return or skip for a special case (empty input, a boundary) is gone",
  "missing-update":
    "an update is missing: a counter, accumulator, or index is never changed where it should be",
};

/** Classes whose bug sits on a line of the buggy code (not a line that is gone). */
export const IN_PLACE: BugClass[] = [
  "off-by-one",
  "wrong-operator",
  "inverted-condition",
  "wrong-variable",
];

export interface Site {
  cls: BugClass;
  /** The function the site is in. */
  fn: string;
  /** The statement changed, or the one removed. */
  stmt: Stmt;
  /** What the change does, for a person: "`<` became `<=`". */
  note: string;
  apply(): void;
}

const SWAP_BOUNDARY: Partial<Record<BinaryOp, BinaryOp>> = {
  "<": "<=",
  "<=": "<",
  ">": ">=",
  ">=": ">",
};
const FLIP: Partial<Record<BinaryOp, BinaryOp>> = {
  "<": ">",
  ">": "<",
  "<=": ">=",
  ">=": "<=",
};
const ARITH: Partial<Record<BinaryOp, BinaryOp>> = {
  "+": "-",
  "-": "+",
  "*": "/",
  "/": "*",
  "&&": "||",
  "||": "&&",
};

const code = (e: Expr) => `\`${printExpr(e)}\``;

/** Every mutation site of `m`, in a fixed order; applying one changes `m` in place. */
export function mutationSites(m: Module): Site[] {
  const fns = fnTable(m);
  const sites: Site[] = [];
  for (const f of m.fns) {
    walkScoped(f, fns, (s, env, list) => {
      const add = (cls: BugClass, note: string, apply: () => void) =>
        sites.push({ cls, fn: f.name, stmt: s, note, apply });

      const exprSites = (e: Expr, scope: Env, readOnly: boolean) => {
        const visit = (x: Expr, isCallee: boolean) => {
          if (x.k === "bin") {
            const b = SWAP_BOUNDARY[x.op];
            if (b) {
              const op = b;
              add("off-by-one", `\`${x.op}\` became \`${op}\``, () => {
                x.op = op;
              });
            }
            const flip = FLIP[x.op];
            if (flip) {
              const op = flip;
              add("wrong-operator", `\`${x.op}\` became \`${op}\``, () => {
                x.op = op;
              });
            }
            const arith = ARITH[x.op];
            const numeric =
              typeOf(x.l, scope, fns) === "number" &&
              typeOf(x.r, scope, fns) === "number";
            if (arith && (numeric || x.op === "&&" || x.op === "||")) {
              const op = arith;
              add("wrong-operator", `\`${x.op}\` became \`${op}\``, () => {
                x.op = op;
              });
            }
            if (
              (x.op === "-" || x.op === "+") &&
              x.r.k === "num" &&
              x.r.v === 1 &&
              typeOf(x.l, scope, fns) === "number"
            ) {
              const before = printExpr(x);
              add("off-by-one", `\`${before}\` became ${code(x.l)}`, () => {
                replaceExpr(x, x.l);
              });
            }
          }
          if (
            x.k === "call" &&
            x.callee.k === "mem" &&
            x.callee.obj.k === "id" &&
            x.callee.obj.name === "Math" &&
            (x.callee.prop === "min" || x.callee.prop === "max")
          ) {
            const callee = x.callee;
            const other = callee.prop === "min" ? "max" : "min";
            add(
              "wrong-operator",
              `\`Math.${callee.prop}\` became \`Math.${other}\``,
              () => {
                callee.prop = other;
              },
            );
          }
          if (x.k === "id" && !isCallee && !readOnly) {
            const t = scope.get(x.name);
            if (t)
              for (const [name, type] of scope)
                if (type === t && name !== x.name) {
                  const from = x.name;
                  add(
                    "wrong-variable",
                    `\`${from}\` became \`${name}\``,
                    () => {
                      x.name = name;
                    },
                  );
                }
          }
          if (x.k === "call") {
            if (x.callee.k === "mem") visit(x.callee.obj, false);
            for (const a of x.args) visit(a, false);
            return;
          }
          if (x.k === "mem") {
            visit(x.obj, false);
            return;
          }
          switch (x.k) {
            case "arr":
              for (const item of x.items) visit(item, false);
              break;
            case "bin":
              visit(x.l, false);
              visit(x.r, false);
              break;
            case "un":
              visit(x.e, false);
              break;
            case "cond":
              visit(x.c, false);
              visit(x.t, false);
              visit(x.f, false);
              break;
            case "idx":
              visit(x.obj, false);
              visit(x.index, false);
              break;
            default:
              break;
          }
        };
        visit(e, false);
      };

      const invert = (holder: { c: Expr }) => {
        const c = holder.c;
        if (c.k === "bin" && (c.op === "===" || c.op === "!==")) {
          const op = c.op === "===" ? "!==" : "===";
          add("inverted-condition", `\`${c.op}\` became \`${op}\``, () => {
            c.op = op;
          });
        } else if (c.k === "un" && c.op === "!") {
          add("inverted-condition", `${code(c)} lost its \`!\``, () => {
            holder.c = c.e;
          });
        } else
          add("inverted-condition", `${code(c)} became negated`, () => {
            holder.c = { k: "un", op: "!", e: c };
          });
      };

      switch (s.k) {
        case "if":
          invert(s);
          exprSites(s.c, env, false);
          if (!s.else) {
            const last = s.consequent[s.consequent.length - 1];
            if (
              last &&
              ["return", "throw", "continue", "break"].includes(last.k)
            )
              add(
                "missing-guard",
                `the guard \`if (${printExpr(s.c)})\` is gone`,
                () => {
                  list.splice(list.indexOf(s), 1);
                },
              );
          }
          return;
        case "while":
          invert(s);
          exprSites(s.c, env, false);
          return;
        case "for": {
          const inner = loopEnv(s, env, fns);
          if (s.init.k === "let" && s.init.init.k === "num") {
            const init = s.init.init;
            if (init.v === 0 || init.v === 1) {
              const v = init.v === 0 ? 1 : 0;
              add(
                "off-by-one",
                `the loop starts at ${v}, not ${init.v}`,
                () => {
                  init.v = v;
                },
              );
            }
          }
          exprSites(s.test, inner, false);
          return;
        }
        case "assign":
        case "inc":
          add(
            "missing-update",
            `\`${s.k === "inc" ? `${printExpr(s.target)}${s.op}` : `${printExpr(s.target)} ${s.op} …`}\` is gone`,
            () => {
              list.splice(list.indexOf(s), 1);
            },
          );
          if (s.k === "assign") exprSites(s.value, env, false);
          return;
        default:
          for (const e of stmtExprs(s)) {
            if (e.k === "cond") invert(e);
            exprSites(e, env, false);
          }
      }
    });
  }
  return sites;
}

export interface Mutant {
  module: Module;
  site: Omit<Site, "apply">;
}

/** The `index`th mutant of `m`, a fresh copy; `m` is untouched. */
export function mutant(m: Module, index: number): Mutant {
  const copy = cloneModule(m);
  const site = mutationSites(copy)[index];
  if (!site) throw new Error(`no mutation site ${index}`);
  site.apply();
  const { apply: _, ...rest } = site;
  return { module: copy, site: rest };
}

/** Every call's outcome, in order. */
export const outcomes = (m: Module, fn: string, inputs: Value[][]): Outcome[] =>
  inputs.map((args) => runCall(m, fn, args));

/** The first input on which `b` behaves differently from `a`, or -1 when none does. */
export function differs(
  a: Module,
  b: Module,
  fn: string,
  inputs: Value[][],
): number {
  return inputs.findIndex(
    (args) => !sameOutcome(runCall(a, fn, args), runCall(b, fn, args)),
  );
}
