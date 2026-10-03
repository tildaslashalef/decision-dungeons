// A small Web Audio organ for the play view: four voices per chord, each a
// few sine partials under a soft envelope. Browser only, and only after a
// person's click (browsers keep audio silent until then); nothing here
// touches the run.

import { NUMERALS, type Placed, SCALE, type Tune } from "./music.ts";

let context: AudioContext | undefined;

/** The context, made or resumed on a click. */
export function organ(): AudioContext {
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
  return context;
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** The four voices of a chord: the melody, two inner voices filled with the chord's other tones, the bass. */
export function voicing(tune: Tune, p: Placed): number[] {
  const pcs = NUMERALS[p.option.numeral].tones.map(
    (d) => (tune.key.tonic + (SCALE[d] as number)) % 12,
  );
  const missing = (have: number[]) =>
    pcs.filter((pc) => !have.some((m) => m % 12 === pc));
  const below = (top: number, floor: number, have: number[]) => {
    const want = missing(have);
    let fallback: number | undefined;
    for (let m = top - 1; m > floor; m--) {
      if (!pcs.includes(m % 12)) continue;
      if (want.includes(m % 12)) return m;
      fallback ??= m;
    }
    return fallback ?? top - 12;
  };
  const alto = below(p.melody.midi, Math.max(p.bass + 4, p.melody.midi - 10), [
    p.melody.midi,
    p.bass,
  ]);
  const tenor = below(alto, p.bass + 2, [p.melody.midi, p.bass, alto]);
  return [p.melody.midi, alto, tenor, p.bass];
}

function voice(
  ctx: AudioContext,
  midi: number,
  at: number,
  length: number,
  out: AudioNode,
): void {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(1, at + 0.05);
  gain.gain.setValueAtTime(1, at + length - 0.12);
  gain.gain.linearRampToValueAtTime(0, at + length);
  gain.connect(out);
  for (const [partial, level] of [
    [1, 0.6],
    [2, 0.28],
    [3, 0.1],
    [4, 0.06],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = hz(midi) * partial;
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(gain);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }
}

/** Plays chords one after another, `beat` seconds each; returns when the last ends, in seconds from now. */
export function play(tune: Tune, chords: Placed[], beat = 0.85): number {
  const ctx = organ();
  const out = ctx.createGain();
  out.gain.value = 0.07;
  out.connect(ctx.destination);
  const start = ctx.currentTime + 0.05;
  chords.forEach((p, i) => {
    const last =
      i === chords.length - 1 && chords.length === tune.melody.length;
    for (const midi of voicing(tune, p))
      voice(ctx, midi, start + i * beat, last ? beat * 2 : beat, out);
  });
  return chords.length * beat + 0.3;
}
