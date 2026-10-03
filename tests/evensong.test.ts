import { describe, expect, test } from "bun:test";
import { decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
import { parseRequest } from "../src/contract/validate.ts";
import { randomDecider } from "../src/deciders/random.ts";
import type { AnyDungeon } from "../src/dungeons/dungeon.ts";
import {
  type EvensongRun,
  evensong,
} from "../src/dungeons/evensong/evensong.ts";
import {
  bassPitch,
  faults,
  KEYS,
  NUMERALS,
  noteAt,
  optionById,
  type Placed,
  parseNote,
  SCALE,
  spell,
  type Tune,
} from "../src/dungeons/evensong/music.ts";
import { voicing } from "../src/dungeons/evensong/organ.ts";
import { runEpisode } from "../src/dungeons/run.ts";

const dungeon = evensong as AnyDungeon;
const options = (model: string, seed = 1) => ({
  model,
  seed,
  signal: AbortSignal.timeout(2000),
});
const C = KEYS[0] as (typeof KEYS)[number];
const tuneOf = (steps: number[], phraseEnds = [steps.length - 1]): Tune => ({
  key: C,
  melody: steps.map((s) => noteAt(C, s)),
  phraseEnds,
});
const place = (tune: Tune, i: number, id: string, bass?: string): Placed => {
  const option = optionById(id);
  if (!option) throw new Error(id);
  return {
    option,
    melody: tune.melody[i] as Placed["melody"],
    bass: bass ? parseNote(bass) : bassPitch(C, option),
  };
};

describe("the music", () => {
  test("notes spell in their key and read back", () => {
    for (const key of KEYS)
      for (let step = -3; step <= 10; step++) {
        const { midi } = noteAt(key, step);
        expect(parseNote(spell(key, midi))).toBe(midi);
      }
    expect(spell(KEYS[2] as (typeof KEYS)[number], 70)).toBe("Bb4");
    expect(spell(KEYS[1] as (typeof KEYS)[number], 66)).toBe("F#4");
  });

  test("the rules catch consecutive fifths, retrogressions, the leading tone, and the cadence", () => {
    // G4 over C3 (a fifth), then A4 over D3 (a fifth again, both moving).
    const t = tuneOf([4, 5, 4, 0]);
    const fifths = faults(
      t,
      1,
      place(t, 1, "ii", "D3"),
      place(t, 0, "I", "C3"),
    );
    expect(fifths.map((f) => f.fault)).toContain("parallels");
    const back = faults(t, 1, place(t, 1, "IV"), place(t, 0, "V"));
    expect(back.map((f) => f.fault)).toContain("retrogression");
    const lt = tuneOf([0, 6, 7]);
    expect(
      faults(lt, 1, place(lt, 1, "V6"), place(lt, 0, "I")).map((f) => f.text),
    ).toContain("the leading tone is doubled in melody and bass");
    const end = tuneOf([2, 1, 0]);
    expect(
      faults(end, 2, place(end, 2, "I"), place(end, 1, "ii")).map(
        (f) => f.fault,
      ),
    ).toContain("cadence");
    expect(faults(end, 2, place(end, 2, "I"), place(end, 1, "V"))).toEqual([]);
  });

  test("the organ's voicing holds the chord, melody on top and bass below", () => {
    const run = evensong.create(2, "chorale");
    const t = run.tune;
    for (const id of ["I", "IV6", "V7", "vi"]) {
      const option = optionById(id);
      const note = t.melody.find((n) =>
        NUMERALS[option?.numeral ?? "I"].tones.includes(((n.step % 7) + 7) % 7),
      );
      if (!option || !note) continue;
      const voices = voicing(t, {
        option,
        melody: note,
        bass: bassPitch(t.key, option),
      });
      expect(voices).toEqual([...voices].sort((a, b) => b - a));
      const pcs = NUMERALS[option.numeral].tones.map(
        (d) => (t.key.tonic + (SCALE[d] as number)) % 12,
      );
      for (const v of voices) expect(pcs).toContain(v % 12);
    }
  });
});

describe("evensong runs", () => {
  test("the rule plays every level without a fault", async () => {
    for (const level of evensong.levels)
      for (const seed of [1, 2, 3, 4]) {
        const result = await runEpisode(
          dungeon,
          level.id,
          seed,
          { id: "rule", model: "baseline" },
          (r) => decideWith(evensong.rule, r, options("baseline")),
        );
        expect(result.outcome.passed).toBe(true);
        expect(result.outcome.violations).toBe(0);
      }
  });

  test("random breaks the rules", async () => {
    let faulted = 0;
    for (const seed of [1, 2, 3, 4]) {
      const result = await runEpisode(
        dungeon,
        "chorale",
        seed,
        { id: "random", model: "uniform" },
        (r) => decideWith(randomDecider(), r, options("uniform", seed)),
      );
      if (result.outcome.passed === false) faulted++;
    }
    expect(faulted).toBe(4);
  });

  test("requests are valid and offer only chords that hold the note; by heart drops the rules", () => {
    const run = evensong.create(3, "hymn") as EvensongRun;
    const heart = evensong.create(3, "by-heart") as EvensongRun;
    expect(heart.tune).toEqual(run.tune);
    const asked: Request = evensong.observe(run).request;
    expect(() => parseRequest(asked)).not.toThrow();
    const question = asked.questions.chord;
    if (question?.type !== "choice") throw new Error("no chord question");
    const note = run.tune.melody[0];
    for (const id of Object.keys(question.criteria)) {
      const option = optionById(id);
      expect(
        NUMERALS[option?.numeral ?? "I"].tones.includes(
          (((note?.step ?? 0) % 7) + 7) % 7,
        ),
      ).toBe(true);
      expect(question.criteria[id]).toContain("in the bass");
    }
    expect(question.instructions).toContain("Rules of the loft");
    expect(
      evensong.observe(heart).request.questions.chord?.instructions,
    ).not.toContain("Rules of the loft");
  });
});
