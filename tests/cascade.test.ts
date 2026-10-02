import { describe, expect, test } from "bun:test";
import type { Decision } from "../src/contract/answer.ts";
import { decideManyWith, decideWith } from "../src/contract/decider.ts";
import type { Request } from "../src/contract/request.ts";
import {
  cascadeDecider,
  parseCascade,
  sureness,
} from "../src/deciders/cascade.ts";
import { nuclisDecider } from "../src/deciders/nuclis.ts";
import { nuclisHttp } from "../src/deciders/nuclis-http.ts";
import { crossing } from "../src/dungeons/crossing/crossing.ts";
import type { AnyDungeon } from "../src/dungeons/dungeon.ts";
import { runEpisode } from "../src/dungeons/run.ts";
import {
  decideOutput,
  FAKE_NUCLIS_URL,
  fakeNuclis,
  ok,
} from "./fake-nuclis.ts";

/** A result whose one answer says `choice` with probability `p`. */
function result(choice: string, p: number, truncated = false) {
  const one = decideOutput(choice).results[0] as ReturnType<
    typeof decideOutput
  >["results"][number];
  const other = choice === "stop" ? "drive" : "stop";
  return {
    ...one,
    answers: {
      motion: {
        ...one.answers.motion,
        choice,
        probabilities: {
          [choice]: p,
          [other]: Math.round((1 - p) * 1e4) / 1e4,
        },
      },
    },
    nuclis: { ...one.nuclis, truncated },
  };
}

const request: Request = {
  state: { n: 0 },
  questions: {
    motion: {
      type: "choice",
      instructions: "Drive or stop?",
      criteria: { drive: "keep moving", stop: "brake now" },
    },
  },
};
const withState = (n: number): Request => ({ ...request, state: { n } });

/**
 * laya answers stop, sure for even states and unsure for odd ones (state 3
 * also cut); clef answers drive.
 */
function setup() {
  const fake = fakeNuclis({
    decisions: (raw) => {
      const body = raw as {
        model: string;
        state?: { n: number };
        states?: { n: number }[];
      };
      const states = body.states ?? [body.state as { n: number }];
      const results = states.map(({ n }) =>
        body.model === "clef-flash"
          ? result("drive", 0.9)
          : result("stop", n % 2 === 0 ? 0.95 : 0.6, n === 3),
      );
      return ok({ ...decideOutput(), model: body.model, results });
    },
  });
  const nuclis = nuclisDecider(
    nuclisHttp({ url: FAKE_NUCLIS_URL, fetch: fake.fetch }),
  );
  return { fake, cascade: cascadeDecider(nuclis) };
}
const posts = (fake: ReturnType<typeof fakeNuclis>) =>
  fake.calls
    .filter((c) => c.method === "POST")
    .map((c) => c.body as { model: string; states?: unknown[] });
const options = (model = "laya:clef-flash@0.85") => ({
  model,
  signal: AbortSignal.timeout(5000),
});

describe("cascade", () => {
  test("names its pair and threshold in the model id", () => {
    expect(parseCascade("laya:clef-flash@0.7")).toEqual({
      screener: "laya",
      judge: "clef-flash",
      threshold: 0.7,
    });
    expect(parseCascade("laya:clef-flash").threshold).toBe(0.85);
    expect(() => parseCascade("laya@0.7")).toThrow();
    expect(() => parseCascade("laya:clef-flash@1.5")).toThrow();
    expect(sureness({ type: "noul", noul: 0.2 })).toBe(0.8);
  });

  test("pairs every model that packs with every one that does not", async () => {
    const { cascade } = setup();
    expect(await cascade.models()).toEqual([
      {
        id: "laya:clef-flash@0.85",
        label: "laya → clef-flash",
        available: true,
        images: true,
      },
      {
        id: "laya-multilingual:clef-flash@0.85",
        label: "laya-multilingual → clef-flash",
        available: true,
        images: true,
      },
    ]);
  });

  test("keeps a sure screen, and asks the judge when unsure, cut, or shown a picture", async () => {
    const { fake, cascade } = setup();
    const sure = await decideWith(cascade, withState(0), options());
    expect(sure.answers.motion).toMatchObject({ choice: "stop" });
    expect(sure.debug?.cascade).toEqual({
      screener: "laya",
      judge: "clef-flash",
      threshold: 0.85,
      screenConfidence: 0.95,
      escalated: false,
    });
    expect(sure.model).toBe("laya:clef-flash@0.85");
    expect(posts(fake).map((b) => b.model)).toEqual(["laya"]);

    const unsure = await decideWith(cascade, withState(1), options());
    expect(unsure.answers.motion).toMatchObject({ choice: "drive" });
    expect(unsure.debug?.cascade).toMatchObject({
      screenConfidence: 0.6,
      escalated: true,
      reason: "unsure",
    });
    // A lower threshold keeps the same screen.
    const lower = await decideWith(
      cascade,
      withState(1),
      options("laya:clef-flash@0.5"),
    );
    expect(lower.debug?.cascade?.escalated).toBe(false);

    const cut = await decideWith(
      cascade,
      withState(3),
      options("laya:clef-flash@0.5"),
    );
    expect(cut.debug?.cascade).toMatchObject({
      escalated: true,
      reason: "truncated",
    });

    const before = posts(fake).length;
    const pictured = await decideWith(
      cascade,
      { ...withState(0), images: ["data:image/png;base64,AA=="] },
      options(),
    );
    expect(pictured.debug?.cascade).toMatchObject({
      escalated: true,
      reason: "images",
    });
    expect(pictured.debug?.cascade).not.toHaveProperty("screenConfidence");
    expect(
      posts(fake)
        .slice(before)
        .map((b) => b.model),
    ).toEqual(["clef-flash"]);
  });

  test("screens a batch in one call and judges only the unsure, one at a time", async () => {
    const { fake, cascade } = setup();
    const requests = [0, 1, 2, 3, 4, 5].map(withState);
    const decisions = await decideManyWith(cascade, requests, options());
    expect(
      decisions.map(
        (d) => d.answers.motion?.type === "choice" && d.answers.motion.choice,
      ),
    ).toEqual(["stop", "drive", "stop", "drive", "stop", "drive"]);
    expect(posts(fake).map((b) => [b.model, b.states?.length ?? 1])).toEqual([
      ["laya", 6],
      ["clef-flash", 1],
      ["clef-flash", 1],
      ["clef-flash", 1],
    ]);
    expect(await cascade.batches?.("laya:clef-flash")).toBe(true);
  });

  test("a run counts the decisions the judge answered", async () => {
    const { cascade } = setup();
    const result = await runEpisode(
      crossing as AnyDungeon,
      "distance",
      1,
      { id: "cascade", model: "laya:clef-flash@0.85" },
      (r) => decideWith(cascade, r, options()) as Promise<Decision>,
    );
    expect(result.escalated).toBeGreaterThanOrEqual(0);
    expect(result.escalated).toBeLessThanOrEqual(result.asked);
    expect(result.model).toBe("laya:clef-flash@0.85");
  });
});
