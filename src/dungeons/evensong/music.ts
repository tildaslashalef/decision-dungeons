// Evensong's music: major keys, notes spelled in them, the chords a melody
// note can take, and the rules of the organ loft as checks on one chord
// following another. Every judgement is a rule here, never a model's taste.
// Pure and deterministic.

import { hash, type Rng, seeded } from "../../lib/random.ts";

export interface Key {
  name: string;
  /** The tonic's MIDI number in the fourth octave (C4 = 60). */
  tonic: number;
  /** The tonic's letter, an index into LETTERS. */
  letter: number;
}

export const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
const NATURAL = [0, 2, 4, 5, 7, 9, 11];
/** Semitones above the tonic of each degree of the major scale. */
export const SCALE = [0, 2, 4, 5, 7, 9, 11];

export const KEYS: Key[] = [
  { name: "C major", tonic: 60, letter: 0 },
  { name: "D major", tonic: 62, letter: 1 },
  { name: "F major", tonic: 65, letter: 3 },
  { name: "G major", tonic: 67, letter: 4 },
];

/** A note of the key: its scale step above the key's tonic (0 the tonic; 7 an octave up) and its pitch. */
export interface Note {
  step: number;
  midi: number;
}

/** The degree 0–6 of a scale step, in any octave. */
export const degree = (step: number) => ((step % 7) + 7) % 7;

export function noteAt(key: Key, step: number): Note {
  const octave = Math.floor(step / 7);
  return {
    step,
    midi: key.tonic + 12 * octave + (SCALE[degree(step)] as number),
  };
}

/** A pitch of the key spelled with its letter, accidental, and octave: "F#4". */
export function spell(key: Key, midi: number): string {
  const pc = (((midi - key.tonic) % 12) + 12) % 12;
  const d = SCALE.indexOf(pc);
  if (d < 0) throw new Error(`${midi} is not in ${key.name}`);
  const letter = (key.letter + d) % 7;
  // The octave of the letter, so that B#3 or Cb4 would come out right.
  let octave = Math.floor(midi / 12) - 1;
  const natural = (NATURAL[letter] as number) + 12 * (octave + 1);
  if (natural - midi > 6) octave--;
  if (midi - natural > 6) octave++;
  const accidental = midi - ((NATURAL[letter] as number) + 12 * (octave + 1));
  return `${LETTERS[letter]}${accidental > 0 ? "#".repeat(accidental) : "b".repeat(-accidental)}${octave}`;
}

/** Reads "F#4", "Bb2", or "C5" back into a MIDI number. */
export function parseNote(name: string): number {
  const m = /^([A-G])([#b]*)(-?\d)$/.exec(name);
  if (!m) throw new Error(`not a note: ${name}`);
  const base = NATURAL[LETTERS.indexOf(m[1] as string)] as number;
  const shift = [...(m[2] ?? "")].reduce((n, c) => n + (c === "#" ? 1 : -1), 0);
  return base + shift + 12 * (Number(m[3]) + 1);
}

// --- Chords ----------------------------------------------------------------

export type Numeral = "I" | "ii" | "iii" | "IV" | "V" | "vi" | "V7";
export type Role = "tonic" | "predominant" | "dominant";

export const NUMERALS: Record<
  Numeral,
  { root: number; tones: number[]; role: Role; quality: string }
> = {
  I: { root: 0, tones: [0, 2, 4], role: "tonic", quality: "major" },
  ii: { root: 1, tones: [1, 3, 5], role: "predominant", quality: "minor" },
  iii: { root: 2, tones: [2, 4, 6], role: "tonic", quality: "minor" },
  IV: { root: 3, tones: [3, 5, 0], role: "predominant", quality: "major" },
  V: { root: 4, tones: [4, 6, 1], role: "dominant", quality: "major" },
  vi: { root: 5, tones: [5, 0, 2], role: "tonic", quality: "minor" },
  V7: {
    root: 4,
    tones: [4, 6, 1, 3],
    role: "dominant",
    quality: "dominant seventh",
  },
};

/** A chord as offered: a numeral, root position, or first inversion ("6"). V7 only in root position. */
export interface ChordOption {
  id: string;
  numeral: Numeral;
  inversion: 0 | 1;
}

export const OPTIONS: ChordOption[] = (
  ["I", "ii", "iii", "IV", "V", "vi"] as Numeral[]
)
  .flatMap((numeral): ChordOption[] => [
    { id: numeral, numeral, inversion: 0 },
    { id: `${numeral}6`, numeral, inversion: 1 },
  ])
  .concat([{ id: "V7", numeral: "V7", inversion: 0 }]);

export const optionById = (id: string) => OPTIONS.find((o) => o.id === id);

/** The chords whose tones hold the melody note. */
export function optionsFor(note: Note): ChordOption[] {
  return OPTIONS.filter((o) =>
    NUMERALS[o.numeral].tones.includes(degree(note.step)),
  );
}

/** The bass's scale degree under an option: the root, or the third in first inversion. */
export const bassDegree = (o: ChordOption) =>
  NUMERALS[o.numeral].tones[o.inversion] as number;

export const BASS_LOW = 40; // E2
export const BASS_HIGH = 57; // A3

/** The bass's pitch: the option's bass degree nearest the last bass, or near C3 first; ties go down. */
export function bassPitch(key: Key, o: ChordOption, previous?: number): number {
  const pc = (key.tonic + (SCALE[bassDegree(o)] as number)) % 12;
  const target = previous ?? 48;
  let best = -1;
  for (let m = BASS_LOW; m <= BASS_HIGH; m++)
    if (
      m % 12 === pc &&
      (best < 0 || Math.abs(m - target) < Math.abs(best - target))
    )
      best = m;
  return best;
}

const INTERVALS = [
  "unison or octave",
  "minor second",
  "major second",
  "minor third",
  "major third",
  "perfect fourth",
  "tritone",
  "perfect fifth",
  "minor sixth",
  "major sixth",
  "minor seventh",
  "major seventh",
];

/** An interval's name between two pitches, compound intervals reduced to their simple form. */
export function intervalName(low: number, high: number): string {
  const n = Math.abs(high - low);
  if (n === 0) return "unison";
  if (n % 12 === 0) return n === 12 ? "octave" : `${n / 12} octaves`;
  return INTERVALS[n % 12] as string;
}

// --- The rules of the loft --------------------------------------------------

export type Fault = "parallels" | "retrogression" | "cadence" | "voice";

export interface Placed {
  option: ChordOption;
  melody: Note;
  bass: number;
}

export interface Tune {
  key: Key;
  melody: Note[];
  /** Indices of the notes that end a phrase; the last note ends the last. */
  phraseEnds: number[];
}

/**
 * What a chord breaks, placed at `index` of the tune after `previous`: each
 * fault with a line for a person. Empty when it keeps every rule.
 */
export function faults(
  tune: Tune,
  index: number,
  current: Placed,
  previous?: Placed,
): { fault: Fault; text: string }[] {
  const out: { fault: Fault; text: string }[] = [];
  const o = current.option;
  const last = index === tune.melody.length - 1;
  if (index === 0 && o.id !== "I")
    out.push({
      fault: "cadence",
      text: "does not begin on I with its root in the bass",
    });
  if (previous) {
    const before = previous.melody.midi - previous.bass;
    const now = current.melody.midi - current.bass;
    const perfect = (n: number) => n % 12 === 0 || n % 12 === 7;
    if (
      perfect(before) &&
      perfect(now) &&
      before % 12 === now % 12 &&
      previous.melody.midi !== current.melody.midi &&
      previous.bass !== current.bass
    )
      out.push({
        fault: "parallels",
        text:
          now % 12 === 7
            ? "consecutive fifths with the melody"
            : "consecutive octaves with the melody",
      });
    const from = NUMERALS[previous.option.numeral].role;
    const to = NUMERALS[o.numeral].role;
    const p = previous.option.numeral;
    if (from === "dominant" && to === "predominant")
      out.push({
        fault: "retrogression",
        text: `${previous.option.id} falls back to ${o.id}`,
      });
    if (p === "ii" && o.numeral !== "ii" && to !== "dominant")
      out.push({
        fault: "retrogression",
        text: `ii must go on to the dominant, not ${o.id}`,
      });
    if (p === "IV" && to === "tonic" && o.numeral !== "I")
      out.push({
        fault: "retrogression",
        text: `IV goes to ii, V, or I, not ${o.id}`,
      });
    if (Math.abs(current.bass - previous.bass) % 12 === 6)
      out.push({ fault: "voice", text: "the bass leaps a tritone" });
    if (
      previous.option.numeral === "V7" &&
      degree(previous.melody.step) === 3 &&
      degree(current.melody.step) !== 2
    )
      out.push({
        fault: "voice",
        text: "the seventh of V7 does not fall to the third",
      });
  }
  if (degree(current.melody.step) === 6 && bassDegree(o) === 6)
    out.push({
      fault: "voice",
      text: "the leading tone is doubled in melody and bass",
    });
  if (o.numeral === "V7" && degree(current.melody.step) === 3) {
    const next = tune.melody[index + 1];
    if (!next || degree(next.step) !== 2)
      out.push({
        fault: "voice",
        text: "the seventh of V7 has nowhere to fall",
      });
  }
  if (!last && tune.phraseEnds.includes(index) && o.id !== "V")
    out.push({
      fault: "cadence",
      text: "the phrase does not end on V (a half cadence)",
    });
  if (last) {
    const p = previous?.option.id;
    if (o.id !== "I" || (p !== "V" && p !== "V7"))
      out.push({
        fault: "cadence",
        text: "the hymn does not end V–I with roots in the bass",
      });
  }
  return out;
}

/**
 * The organist who cannot err: the fewest faults over the rest of the tune
 * from `placed`, and among equals the fewest repeated chords and
 * inversions, by dynamic
 * programming over (note, chord, bass pitch). Options are tried in their
 * listed order, so ties break alike everywhere.
 */
export function bestCompletion(
  tune: Tune,
  placed: Placed[],
): { faults: number; options: ChordOption[] } {
  const memo = new Map<string, { cost: number; options: ChordOption[] }>();
  const go = (
    i: number,
    previous?: Placed,
  ): { cost: number; options: ChordOption[] } => {
    const note = tune.melody[i];
    if (!note) return { cost: 0, options: [] };
    const key = `${i}|${previous?.option.id ?? "-"}|${previous?.bass ?? 0}|${previous?.melody.step ?? 0}`;
    const known = memo.get(key);
    if (known) return known;
    let best = { cost: Number.POSITIVE_INFINITY, options: [] as ChordOption[] };
    for (const option of optionsFor(note)) {
      const current = {
        option,
        melody: note,
        bass: bassPitch(tune.key, option, previous?.bass),
      };
      // Faults first; then a chord held over a moving melody, then an inversion.
      const held = previous?.option.numeral === option.numeral ? 2 : 0;
      const here =
        faults(tune, i, current, previous).length * 1000 +
        held +
        option.inversion;
      const rest = go(i + 1, current);
      if (here + rest.cost < best.cost)
        best = { cost: here + rest.cost, options: [option, ...rest.options] };
    }
    memo.set(key, best);
    return best;
  };
  const result = go(placed.length, placed.at(-1));
  return { faults: Math.floor(result.cost / 1000), options: result.options };
}

// --- Tunes -------------------------------------------------------------------

/** The next step of a tune that mostly keeps its direction, by step or a third, and turns at the edges of its range. */
function walk(rng: Rng, from: number, direction: number): [number, number] {
  let dir = rng() < 0.72 ? direction : -direction;
  if (from + dir < 0 || from + dir > 7) dir = -dir;
  const size = rng() < 0.78 ? 1 : 2;
  const to = from + dir * size;
  return to < 0 || to > 7 ? [from + dir, dir] : [to, dir];
}

/**
 * A hymn tune of `phrases` four-note phrases, seeded: it begins on a note
 * of the tonic chord, each inner phrase ends on a note of V, and it ends on
 * the tonic from a note of V. Kept only when a flawless harmony exists.
 */
export function buildTune(name: string, seed: number, phrases: number): Tune {
  const rng = seeded(hash(`evensong:${name}`, seed));
  const key = KEYS[Math.floor(rng() * KEYS.length)] as Key;
  const length = phrases * 4;
  const phraseEnds = Array.from({ length: phrases }, (_, p) => p * 4 + 3);
  const inV = (s: number) => [4, 6, 1].includes(degree(s));
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const steps: number[] = [[0, 2, 4][Math.floor(rng() * 3)] as number];
    let direction = rng() < 0.5 ? 1 : -1;
    while (steps.length < length - 1) {
      const [s, d] = walk(rng, steps.at(-1) as number, direction);
      steps.push(s);
      direction = d;
    }
    steps.push((steps.at(-1) as number) >= 4 ? 7 : 0);
    // A see-saw (up, back, up again) reads as a stuck tune, not a hymn.
    const seesaw = steps.some(
      (s, i) => i >= 3 && s === steps[i - 2] && steps[i - 1] === steps[i - 3],
    );
    const ok =
      !seesaw &&
      phraseEnds.every((e) => e === length - 1 || inV(steps[e] as number)) &&
      inV(steps[length - 2] as number) &&
      Math.abs((steps[length - 1] as number) - (steps[length - 2] as number)) <=
        2;
    if (!ok) continue;
    const tune = { key, melody: steps.map((s) => noteAt(key, s)), phraseEnds };
    if (bestCompletion(tune, []).faults === 0) return tune;
  }
  throw new Error(`no harmonizable ${name} tune for seed ${seed}`);
}
