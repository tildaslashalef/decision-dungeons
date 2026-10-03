// Evensong: the autopilot is the organist, harmonizing a hymn tune one
// chord under each melody note. Each decision is a choice among the chords
// that hold the note; the rules of the loft (consecutive fifths and
// octaves, retrogressions, a doubled leading tone, the cadences) judge it,
// and the rule is an organist who plans the whole tune and never errs. The
// browser plays what was chosen on an organ. Tunes come from the seed.

import type { Answers } from "../../contract/answer.ts";
import type { Decider } from "../../contract/decider.ts";
import { DecideError } from "../../contract/errors.ts";
import type {
  ChoiceQuestion,
  JsonValue,
  Request,
} from "../../contract/request.ts";
import type { DecisionRecord, Dungeon, Level, Outcome } from "../dungeon.ts";
import {
  bassPitch,
  bestCompletion,
  buildTune,
  type ChordOption,
  degree,
  type Fault,
  faults,
  intervalName,
  KEYS,
  type Note,
  NUMERALS,
  optionById,
  optionsFor,
  type Placed,
  parseNote,
  SCALE,
  spell,
  type Tune,
} from "./music.ts";

interface EvensongLevel extends Level {
  phrases: number;
  /** The tune's name, shared by levels that play the same tunes. */
  tune: string;
  /** The rules are stated in the question; false: the organist plays by heart. */
  rules: boolean;
}

const LEVELS: EvensongLevel[] = [
  {
    id: "phrase",
    title: "One phrase",
    description:
      "Four notes, from the opening I to the closing V–I. The rules of the loft are written out. Pass with no fault.",
    phrases: 1,
    tune: "phrase",
    rules: true,
  },
  {
    id: "hymn",
    title: "A hymn",
    description:
      "Eight notes in two phrases: a half cadence on V, then home. The rules are written out.",
    phrases: 2,
    tune: "hymn",
    rules: true,
  },
  {
    id: "chorale",
    title: "A chorale",
    description:
      "Twelve notes in three phrases, two half cadences before the close. The rules are written out.",
    phrases: 3,
    tune: "chorale",
    rules: true,
  },
  {
    id: "by-heart",
    title: "By heart",
    description:
      "The same hymns, but no rules in the question: does the autopilot know harmony without being told?",
    phrases: 2,
    tune: "hymn",
    rules: false,
  },
];

const levelOf = (id: string) => LEVELS.find((l) => l.id === id);

export interface EvensongRun {
  seed: number;
  level: string;
  tune: Tune;
  placed: Placed[];
  /** Each placed chord's faults, by note. */
  faults: { fault: Fault; text: string }[][];
  /** Each placed chord's answer probabilities, when the decider gave them. */
  probabilities: (Record<string, number> | undefined)[];
  records: DecisionRecord[];
}

const RULES = `Rules of the loft. Begin on I with its root in the bass. Tonic chords (I, vi, iii) may go anywhere. IV may go to ii, to V or V7, or back to I; ii goes only to V or V7. The dominant (V, V7) goes to I or vi, never back to ii or IV. Never let the melody and the bass form a perfect fifth, or an octave, on two chords in a row while both move. Never put the leading tone (the 7th degree) in both the melody and the bass. The bass never leaps a tritone. A V7's seventh (the 4th degree) in the melody must fall to the 3rd degree next. Each phrase but the last ends on V with its root in the bass; the hymn ends V or V7, then I, both with their roots in the bass.`;

const ASK =
  "You are the organist at evensong, harmonizing a hymn tune with one chord under each melody note. Roman numerals name the chords of the key; a 6 means the chord's third is in the bass instead of its root.";

const DEGREE_NAMES = [
  "1st degree, the tonic",
  "2nd degree",
  "3rd degree",
  "4th degree",
  "5th degree, the dominant",
  "6th degree",
  "7th degree, the leading tone",
];

const CHORD_NOTES = (tune: Tune, o: ChordOption) =>
  NUMERALS[o.numeral].tones
    .map((d) =>
      spell(tune.key, tune.key.tonic + (SCALE[d] as number)).replace(
        /-?\d$/,
        "",
      ),
    )
    .join(" ");

/** An option's text: the chord, its notes, its bass, and how the bass and the melody meet. */
function optionText(run: EvensongRun, o: ChordOption): string {
  const note = run.tune.melody[run.placed.length] as Note;
  const previous = run.placed.at(-1);
  const bass = bassPitch(run.tune.key, o, previous?.bass);
  const motion = previous
    ? bass === previous.bass
      ? "bass holds"
      : `bass ${bass > previous.bass ? "up" : "down"}: ${intervalName(previous.bass, bass)}`
    : "first chord";
  return `${NUMERALS[o.numeral].quality} (${CHORD_NOTES(run.tune, o)}), ${spell(run.tune.key, bass)} in the bass; ${motion}; melody over bass: ${intervalName(bass, note.midi)}`;
}

export function evensongRequest(run: EvensongRun): Request {
  const level = levelOf(run.level);
  const i = run.placed.length;
  const note = run.tune.melody[i];
  if (!level || !note) throw new Error("the evensong run is over");
  const { key, melody, phraseEnds } = run.tune;
  const name = (n: Note) => spell(key, n.midi);
  const previous = run.placed.at(-1);
  const next = melody[i + 1];
  const where =
    i === melody.length - 1
      ? "the last note of the hymn"
      : phraseEnds.includes(i)
        ? "the last note of a phrase"
        : i === 0
          ? "the first note"
          : "inside a phrase";
  const question: ChoiceQuestion = {
    type: "choice",
    instructions: `${ASK}${level.rules ? ` ${RULES}` : ""} Which chord goes under this note?`,
    criteria: Object.fromEntries(
      optionsFor(note).map((o) => [o.id, optionText(run, o)]),
    ),
  };
  const state: Record<string, JsonValue> = {
    key: key.name,
    tune: phraseEnds
      .map((end, p) =>
        melody
          .slice(p === 0 ? 0 : (phraseEnds[p - 1] as number) + 1, end + 1)
          .map(name)
          .join(" "),
      )
      .join(" | "),
    this_note: {
      note: name(note),
      degree: DEGREE_NAMES[degree(note.step)] as string,
      position: `${i + 1} of ${melody.length}, ${where}`,
      ...(next ? { next_note: name(next) } : {}),
    },
    ...(previous
      ? {
          previous_chord: {
            chord: previous.option.id,
            melody: name(previous.melody),
            bass: spell(key, previous.bass),
            melody_over_bass: intervalName(previous.bass, previous.melody.midi),
          },
        }
      : {}),
    harmony_so_far: run.placed.map(
      (p) =>
        `${name(p.melody)} over ${p.option.id} (bass ${spell(key, p.bass)})`,
    ),
  };
  return { state, questions: { chord: question } };
}

// --- The rule ------------------------------------------------------------------

/** Reads the tune and the harmony so far back from the request, and plays the best next chord. */
function plannedChord(request: Request): string {
  const s = request.state as Record<string, unknown>;
  const key = KEYS.find((k) => k.name === s.key);
  if (!key || typeof s.tune !== "string" || !Array.isArray(s.harmony_so_far))
    throw new Error("no key, tune, and harmony in the state");
  const phrases = s.tune.split(" | ").map((p) => p.split(" ").map(parseNote));
  const notes = phrases.flat();
  const toNote = (midi: number): Note => {
    const pc = (((midi - key.tonic) % 12) + 12) % 12;
    const octave = Math.floor((midi - key.tonic) / 12);
    return { step: SCALE.indexOf(pc) + 7 * octave, midi };
  };
  let end = -1;
  const tune: Tune = {
    key,
    melody: notes.map(toNote),
    phraseEnds: phrases.map((p) => {
      end += p.length;
      return end;
    }),
  };
  const placed: Placed[] = s.harmony_so_far.map((line, i) => {
    const m = /over (\S+) \(bass (\S+)\)$/.exec(String(line));
    const option = m ? optionById(m[1] as string) : undefined;
    if (!m || !option) throw new Error(`cannot read ${String(line)}`);
    return {
      option,
      melody: tune.melody[i] as Note,
      bass: parseNote(m[2] as string),
    };
  });
  const next = bestCompletion(tune, placed).options[0];
  if (!next) throw new Error("the hymn is complete");
  return next.id;
}

const rule: Decider = {
  id: "rule",
  label: "Fixed rule",
  models: async () => [{ id: "baseline", label: "Baseline", available: true }],
  status: async () => ({ configured: true, reachable: true }),
  async decide(request) {
    try {
      return {
        decider: "rule",
        model: "baseline",
        answers: { chord: { type: "choice", choice: plannedChord(request) } },
        timings: { total: 0 },
      };
    } catch (error) {
      throw new DecideError(
        "rejected",
        `the evensong rule cannot read this request: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
};

const count = (run: EvensongRun, fault: Fault) =>
  run.faults.flat().filter((f) => f.fault === fault).length;

export const evensong: Dungeon<EvensongRun> = {
  id: "evensong",
  title: "Evensong",
  description:
    "The autopilot is the organist: one chord under each note of a hymn tune, judged by the rules of harmony, and played back on the organ when it is done.",
  levels: LEVELS.map(({ phrases: _, tune: __, rules: ___, ...level }) => level),
  create(seed, level) {
    const l = levelOf(level);
    if (!l) throw new Error(`evensong has no level ${level}`);
    return {
      seed,
      level,
      tune: buildTune(l.tune, seed, l.phrases),
      placed: [],
      faults: [],
      probabilities: [],
      records: [],
    };
  },
  observe(run) {
    return { request: evensongRequest(run) };
  },
  apply(run, answers: Answers) {
    const answer = answers.chord;
    const i = run.placed.length;
    const note = run.tune.melody[i];
    const option =
      answer?.type === "choice" ? optionById(answer.choice) : undefined;
    if (!note || !option || !optionsFor(note).includes(option)) return;
    const previous = run.placed.at(-1);
    const placed = {
      option,
      melody: note,
      bass: bassPitch(run.tune.key, option, previous?.bass),
    };
    const found = faults(run.tune, i, placed, previous);
    run.placed.push(placed);
    run.faults.push(found);
    run.probabilities.push(
      answer?.type === "choice" ? answer.probabilities : undefined,
    );
    run.records.push({
      index: i,
      summary: `${spell(run.tune.key, note.midi)}: ${option.id}, bass ${spell(run.tune.key, placed.bass)}${found.length ? ` (${found.map((f) => f.text).join("; ")})` : ""}`,
      correct: found.length === 0,
      ...(found.length
        ? { violation: found.map((f) => f.text).join("; ") }
        : {}),
    });
  },
  step() {},
  outcome(run): Outcome {
    const done = run.placed.length >= run.tune.melody.length;
    const violations = run.faults.filter((f) => f.length).length;
    return {
      finished: done,
      ...(done ? { passed: violations === 0 } : {}),
      violations,
      metrics: {
        notes: run.tune.melody.length,
        decided: run.placed.length,
        correct: run.placed.length - violations,
        parallels: count(run, "parallels"),
        retrogressions: count(run, "retrogression"),
        cadence_faults: count(run, "cadence"),
        voice_faults: count(run, "voice"),
        root_position: run.placed.filter((p) => p.option.inversion === 0)
          .length,
      },
      records: run.records,
    };
  },
  rule,
};
