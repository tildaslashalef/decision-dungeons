import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "../src/dungeons/code/diff.ts";
import { runCall, type Value } from "../src/dungeons/code/interp.ts";
import { differs, mutant, mutationSites } from "../src/dungeons/code/mutate.ts";
import { parseExpr, parseModule } from "../src/dungeons/code/parse.ts";
import { printExpr, printModule } from "../src/dungeons/code/print.ts";
import { refactored, refactorSites } from "../src/dungeons/code/refactor.ts";
import { instantiate, TEMPLATES } from "../src/dungeons/code/templates.ts";
import { seeded } from "../src/lib/random.ts";

describe("code AST and parser/printer", () => {
  test("expression parse and print round-trip", () => {
    const exprs = [
      "123",
      '"hello"',
      "true",
      "null",
      "[1, 2, 3]",
      "x + 1",
      "x > 0 && y < 10",
      "!(x === y)",
      "Math.min(a, b)",
      "xs.slice(1, 3)",
      "xs[i]",
      "x ? 1 : 2",
    ];
    for (const src of exprs) {
      const e = parseExpr(src);
      const printed = printExpr(e);
      const e2 = parseExpr(printed);
      expect(printExpr(e2)).toBe(printed);
    }
  });

  test("all templates parse, print, and round-trip faithfully", () => {
    const rng = seeded(42);
    for (const tmpl of TEMPLATES) {
      const inst = instantiate(tmpl, rng);
      const printed = printModule(inst.module);
      expect(printed.text.length).toBeGreaterThan(0);
      const parsedAgain = parseModule(printed.text);
      const printedAgain = printModule(parsedAgain);
      expect(printedAgain.text).toBe(printed.text);
    }
  });
});

describe("interpreter vs native JS", () => {
  test("runs all template instances and matches native JS execution", () => {
    const rng = seeded(1234);
    for (const tmpl of TEMPLATES) {
      const inst = instantiate(tmpl, rng);
      const printed = printModule(inst.module);

      // Create a native function from stripped typescript
      // Since our subset doesn't have complex types, we can use Bun.Transpiler or strip types regex
      const transpiler = new Bun.Transpiler({ loader: "ts" });
      const jsCode = transpiler
        .transformSync(printed.text)
        .replace(/^export /gm, "");
      // Create a function in global context
      const nativeFn = new Function(`${jsCode}; return ${inst.fn};`)();

      // Test against edge cases
      const testInputs = [...tmpl.edges, tmpl.input(rng), tmpl.input(rng)];
      for (const args of testInputs) {
        const interpResult = runCall(inst.module, inst.fn, args);

        let nativeResult: unknown;
        let nativeThrew = false;
        try {
          nativeResult = nativeFn(...structuredClone(args));
        } catch {
          nativeThrew = true;
        }

        if (nativeThrew) {
          expect(interpResult.kind).toBe("throw");
        } else {
          expect(interpResult.kind).toBe("value");
          if (interpResult.kind === "value") {
            expect(interpResult.value).toEqual(nativeResult as Value);
          }
        }
      }
    }
  });
});

describe("mutations and refactors", () => {
  test("mutation sites exist and differ on at least some inputs", () => {
    const rng = seeded(999);
    for (const tmpl of TEMPLATES) {
      const inst = instantiate(tmpl, rng);
      const sites = mutationSites(inst.module);
      expect(sites.length).toBeGreaterThan(0);

      // Verify at least one mutant triggers a behavioural change
      let foundBug = false;
      const testInputs = [
        ...tmpl.edges,
        tmpl.input(rng),
        tmpl.input(rng),
        tmpl.input(rng),
      ];
      for (let i = 0; i < Math.min(sites.length, 5); i++) {
        const m = mutant(inst.module, i);
        const idx = differs(inst.module, m.module, inst.fn, testInputs);
        if (idx !== -1) {
          foundBug = true;
          break;
        }
      }
      expect(foundBug).toBe(true);
    }
  });

  test("refactors preserve all outputs across edge cases and random inputs", () => {
    const rng = seeded(777);
    for (const tmpl of TEMPLATES) {
      const inst = instantiate(tmpl, rng);
      const sites = refactorSites(inst.module);
      if (sites.length === 0) continue;

      const ref = refactored(
        inst.module,
        (s) => (s.length > 0 ? 0 : undefined),
        1,
      );
      const testInputs = [...tmpl.edges, tmpl.input(rng), tmpl.input(rng)];
      const diffIdx = differs(inst.module, ref.module, inst.fn, testInputs);
      expect(diffIdx).toBe(-1);
    }
  });
});

describe("unified diff", () => {
  test("generates correct patch format", () => {
    const oldCode = `function test(x: number): number {\n  return x + 1;\n}\n`;
    const newCode = `function test(x: number): number {\n  return x + 2;\n}\n`;
    const diff = unifiedDiff(oldCode, newCode, "test.ts");
    expect(diff).toContain("--- a/test.ts");
    expect(diff).toContain("+++ b/test.ts");
    expect(diff).toContain("-  return x + 1;");
    expect(diff).toContain("+  return x + 2;");
  });
});
