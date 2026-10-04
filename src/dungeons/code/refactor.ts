// Rewrites that keep behaviour: what a tidy-up pull request does. Each is
// safe by construction for the subset (pure expressions, no closures), and
// the generators still check every refactored version against the
// original on the full suite before calling it safe. Pure.

import {
  type BinaryOp,
  cloneModule,
  type Expr,
  eachExpr,
  eachStmt,
  type Fn,
  type Module,
  overwrite,
  type Stmt,
  stmtExprs,
} from "./ast.ts";
import { printExpr } from "./print.ts";
import { fnTable, loopEnv, typeOf, walkScoped } from "./types.ts";

export type RefactorKind =
  | "rename"
  | "increment"
  | "compound"
  | "mirror"
  | "commute"
  | "invert-if"
  | "extract"
  | "for-to-while";

export interface RefactorSite {
  kind: RefactorKind;
  fn: string;
  /** What the rewrite does, for a person. */
  note: string;
  apply(): void;
}

const SYNONYMS: Record<string, string[]> = {
  total: ["sum", "acc", "running"],
  acc: ["total", "sum"],
  sum: ["total", "acc"],
  count: ["hits", "n", "matches"],
  out: ["result", "res", "parts"],
  i: ["idx", "k"],
  j: ["end", "k"],
  best: ["top", "bestSoFar"],
  current: ["here", "runSum"],
  seen: ["kept", "uniq"],
  words: ["parts", "tokens"],
  w: ["word", "part"],
  x: ["v", "item"],
  ch: ["c", "letter"],
  first: ["largest", "top"],
  second: ["next", "runnerUp"],
  lo: ["low", "left"],
  hi: ["high", "right"],
  mid: ["middle", "m"],
  left: ["l", "lo"],
  right: ["r", "hi"],
  rest: ["remaining", "left"],
  run: ["streak", "length"],
  shift: ["offset", "by"],
  start: ["offset", "from"],
  s: ["ordered", "sortedValues"],
  m: ["extreme", "found"],
  tmp: ["swap", "held"],
};

const MIRROR: Partial<Record<BinaryOp, BinaryOp>> = {
  "<": ">",
  ">": "<",
  "<=": ">=",
  ">=": "<=",
  "===": "===",
  "!==": "!==",
};

/** Every name a function uses: parameters, locals, loop variables, calls. */
function namesIn(f: Fn): Set<string> {
  const names = new Set(f.params.map((p) => p.name));
  names.add(f.name);
  eachStmt(f.body, (s) => {
    if (s.k === "let") names.add(s.name);
    if (s.k === "forof") names.add(s.name);
    if (s.k === "for" && s.init.k === "let") names.add(s.init.name);
    const exprs = [...stmtExprs(s)];
    if (s.k === "for") exprs.push(...stmtExprs(s.init), ...stmtExprs(s.update));
    for (const e of exprs)
      eachExpr(e, (x) => {
        if (x.k === "id") names.add(x.name);
      });
  });
  return names;
}

/** Renames every use of `from` in `body` to `to`; the caller has checked `to` is free. */
function renameIn(body: Stmt[], from: string, to: string) {
  const fix = (e: Expr) =>
    eachExpr(e, (x) => {
      if (x.k === "id" && x.name === from) x.name = to;
    });
  eachStmt(body, (s) => {
    if (s.k === "let" && s.name === from) s.name = to;
    if (s.k === "forof" && s.name === from) s.name = to;
    if (s.k === "for") {
      if (s.init.k === "let" && s.init.name === from) s.init.name = to;
      stmtExprs(s.init).forEach(fix);
      stmtExprs(s.update).forEach(fix);
    }
    stmtExprs(s).forEach(fix);
  });
}

const hasContinue = (body: Stmt[]) => {
  let found = false;
  eachStmt(body, (s) => {
    if (s.k === "continue") found = true;
  });
  return found;
};

/** Every refactor site of `m`, in a fixed order; applying one changes `m` in place. */
export function refactorSites(m: Module): RefactorSite[] {
  const fns = fnTable(m);
  const sites: RefactorSite[] = [];
  for (const f of m.fns) {
    const add = (kind: RefactorKind, note: string, apply: () => void) =>
      sites.push({ kind, fn: f.name, note, apply });
    const used = namesIn(f);
    const renamed = new Set<string>();

    walkScoped(f, fns, (s, env, list) => {
      // Renames: a local, once per name, to a synonym the function does not use.
      const local =
        s.k === "let"
          ? s.name
          : s.k === "forof"
            ? s.name
            : s.k === "for" && s.init.k === "let"
              ? s.init.name
              : undefined;
      if (local && !renamed.has(local)) {
        renamed.add(local);
        const to = SYNONYMS[local]?.find((n) => !used.has(n));
        if (to)
          add("rename", `\`${local}\` renamed to \`${to}\``, () => {
            renameIn(f.body, local, to);
          });
      }

      const statements: Stmt[] = s.k === "for" ? [s, s.update] : [s];
      for (const t of statements) {
        if (t.k === "inc" && t.target.k === "id") {
          const target = t.target;
          const op = t.op === "++" ? "+=" : "-=";
          add(
            "increment",
            `\`${target.name}${t.op}\` written \`${target.name} ${op} 1\``,
            () => {
              overwrite<Stmt>(t, {
                k: "assign",
                target,
                op,
                value: { k: "num", v: 1 },
              });
            },
          );
        }
        if (
          t.k === "assign" &&
          t.op !== "=" &&
          t.target.k === "id" &&
          typeOf(t.target, s.k === "for" ? loopEnv(s, env, fns) : env, fns) ===
            "number"
        ) {
          const op = t.op === "+=" ? "+" : t.op === "-=" ? "-" : "*";
          const target = t.target;
          add(
            "compound",
            `\`${target.name} ${t.op} …\` written \`${target.name} = ${target.name} ${op} …\``,
            () => {
              t.value = { k: "bin", op, l: { ...target }, r: t.value };
              t.op = "=";
            },
          );
        }
      }

      const scope =
        s.k === "for" || s.k === "forof" ? loopEnv(s, env, fns) : env;
      const exprs = s.k === "for" ? [s.test] : stmtExprs(s);
      for (const e of exprs)
        eachExpr(e, (x) => {
          if (x.k !== "bin") return;
          const mirror = MIRROR[x.op];
          if (mirror) {
            const op = mirror;
            add(
              "mirror",
              `${"`"}${printExpr(x)}${"`"} written with its sides swapped`,
              () => {
                const l = x.l;
                x.l = x.r;
                x.r = l;
                x.op = op;
              },
            );
          }
          if (
            (x.op === "+" || x.op === "*") &&
            typeOf(x.l, scope, fns) === "number" &&
            typeOf(x.r, scope, fns) === "number"
          )
            add(
              "commute",
              `\`${printExpr(x)}\` written with its operands swapped`,
              () => {
                const l = x.l;
                x.l = x.r;
                x.r = l;
              },
            );
        });

      if (
        s.k === "if" &&
        s.else &&
        !(s.else.length === 1 && s.else[0]?.k === "if")
      ) {
        add(
          "invert-if",
          `\`if (${printExpr(s.c)})\` turned around, branches swapped`,
          () => {
            const c = s.c;
            s.c =
              c.k === "bin" && (c.op === "===" || c.op === "!==")
                ? { ...c, op: c.op === "===" ? "!==" : "===" }
                : c.k === "un" && c.op === "!"
                  ? c.e
                  : { k: "un", op: "!", e: c };
            const origConsequent = s.consequent;
            s.consequent = s.else as Stmt[];
            s.else = origConsequent;
          },
        );
      }

      if (
        s.k === "return" &&
        s.e &&
        s.e.k !== "id" &&
        s.e.k !== "num" &&
        s.e.k !== "str" &&
        s.e.k !== "bool" &&
        s.e.k !== "null" &&
        !used.has("result")
      ) {
        const ret = s;
        add("extract", "the returned expression named `result`", () => {
          const at = list.indexOf(ret);
          const e = ret.e as Expr;
          // The declared type keeps literal unions such as `number | null` intact.
          list.splice(
            at,
            1,
            { k: "let", kind: "const", name: "result", type: f.ret, init: e },
            { k: "return", e: { k: "id", name: "result" } },
          );
        });
      }

      if (s.k === "for" && s.init.k === "let" && !hasContinue(s.body)) {
        const name = s.init.name;
        const clash = list.some(
          (o) =>
            o !== s &&
            ((o.k === "let" && o.name === name) ||
              (o.k === "for" && o.init.k === "let" && o.init.name === name)),
        );
        if (!clash) {
          const loop = s;
          add(
            "for-to-while",
            "the `for` loop written as a `while` loop",
            () => {
              const at = list.indexOf(loop);
              list.splice(at, 1, loop.init, {
                k: "while",
                c: loop.test,
                body: [...loop.body, loop.update],
              });
            },
          );
        }
      }
    });
  }
  return sites;
}

export interface Refactored {
  module: Module;
  notes: string[];
  kinds: RefactorKind[];
}

/** `m` with the refactor sites at `indexes` applied in turn, each counted on the module as it then stands. */
export function refactored(
  m: Module,
  picks: (sites: RefactorSite[]) => number | undefined,
  times: number,
): Refactored {
  const copy = cloneModule(m);
  const notes: string[] = [];
  const kinds: RefactorKind[] = [];
  for (let n = 0; n < times; n++) {
    const sites = refactorSites(copy);
    const i = picks(sites);
    const site = i === undefined ? undefined : sites[i];
    if (!site) break;
    site.apply();
    notes.push(site.note);
    kinds.push(site.kind);
  }
  return { module: copy, notes, kinds };
}
