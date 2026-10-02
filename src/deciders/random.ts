// The floor: a uniform choice among the offered options. Each answer is
// drawn from the run's seed and the request itself, so the decider keeps no
// state and the same run gives the same answers in any order or process.

import type { Answer, Answers } from "../contract/answer.ts";
import type { Decider } from "../contract/decider.ts";
import type { Question } from "../contract/request.ts";
import { hash, pick, type Rng, seeded } from "../lib/random.ts";

export const RANDOM_MODEL = "uniform";

function answer(question: Question, rng: Rng): Answer {
  switch (question.type) {
    case "choice": {
      const keys = Object.keys(question.criteria);
      const p = 1 / keys.length;
      return {
        type: "choice",
        choice: pick(rng, keys),
        probabilities: Object.fromEntries(keys.map((key) => [key, p])),
        // 1 − H(p)/ln k, which is 0 for a uniform distribution.
        confidence: 0,
      };
    }
    case "score":
      return {
        type: "score",
        score: Math.floor(rng() * question.criteria.length),
      };
    case "noul":
      return { type: "noul", noul: rng() };
  }
}

export function randomDecider(): Decider {
  return {
    id: "random",
    label: "Random",
    models: async () => [
      { id: RANDOM_MODEL, label: "Uniform choice", available: true },
    ],
    status: async () => ({ configured: true, reachable: true }),
    async decide(request, { seed = 0 }) {
      const rng = seeded(hash(JSON.stringify(request), seed));
      const answers: Answers = {};
      for (const [id, question] of Object.entries(request.questions))
        answers[id] = answer(question, rng);
      return {
        decider: "random",
        model: RANDOM_MODEL,
        answers,
        timings: { total: 0 },
      };
    },
  };
}
