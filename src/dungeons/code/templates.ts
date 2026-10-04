// The functions the code dungeons are written from: everyday TypeScript a
// reviewer meets (bounds, searches, string handling, small algorithms),
// each with `$hole`s for its names, an input generator, and edge cases.
// Some carry helpers, so a bug can sit one call away from the test that
// finds it. Every template must parse, type-check under `strict`, and
// return on every input it generates; the tests hold each to that. Pure.

import { pick, type Rng } from "../../lib/random.ts";
import type { Module } from "./ast.ts";
import type { Value } from "./interp.ts";
import { parseModule } from "./parse.ts";

export interface Template {
  id: string;
  /** What the exported function does, as a pull request or a goal names it. */
  purpose: string;
  src: string;
  /** Choices for each `$hole` in the source, `$fn` the exported function's name. */
  names: Record<string, string[]>;
  /** One random call's arguments. */
  input(rng: Rng): Value[];
  /** Arguments every test suite includes: empty, single, boundaries. */
  edges: Value[][];
}

const int = (rng: Rng, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1));
const ints = (rng: Rng, n: number, lo: number, hi: number) =>
  Array.from({ length: n }, () => int(rng, lo, hi));
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const WORDS = [
  "red",
  "fox",
  "jumps",
  "over",
  "a",
  "lazy",
  "dog",
  "deep",
  "level",
  "noon",
  "harbor",
  "line",
  "test",
];
const word = (rng: Rng) => pick(rng, WORDS);
const sentence = (rng: Rng, n: number) =>
  Array.from({ length: n }, () => word(rng)).join(" ");
const runs = (rng: Rng) =>
  Array.from({ length: int(rng, 1, 5) }, () =>
    pick(rng, ["a", "b", "c", "x"]).repeat(int(rng, 1, 4)),
  ).join("");

const LIST = ["values", "nums", "items", "scores", "readings", "samples"];

export const TEMPLATES: Template[] = [
  {
    id: "clamp",
    purpose: "clamp a value into a range",
    names: { fn: ["clamp", "clampValue", "bound"], v: ["value", "x", "n"] },
    src: `
function $fn($v: number, min: number, max: number): number {
  if ($v < min) {
    return min;
  }
  if ($v > max) {
    return max;
  }
  return $v;
}`,
    input: (rng) => {
      const lo = int(rng, -10, 10);
      return [int(rng, -20, 30), lo, lo + int(rng, 0, 15)];
    },
    edges: [
      [5, 5, 5],
      [0, 0, 10],
      [10, 0, 10],
      [-1, 0, 10],
      [11, 0, 10],
    ],
  },
  {
    id: "sum-range",
    purpose: "sum the values between two indexes, end excluded",
    names: { fn: ["sumRange", "rangeSum", "sumBetween"], xs: LIST },
    src: `
function $fn($xs: number[], start: number, end: number): number {
  let total = 0;
  for (let i = start; i < end; i++) {
    total += $xs[i];
  }
  return total;
}`,
    input: (rng) => {
      const xs = ints(rng, int(rng, 1, 8), -5, 20);
      const a = int(rng, 0, xs.length);
      return [xs, a, int(rng, a, xs.length)];
    },
    edges: [
      [[], 0, 0],
      [[4], 0, 1],
      [[1, 2, 3], 0, 3],
      [[1, 2, 3], 1, 1],
      [[5, 6, 7, 8], 2, 4],
    ],
  },
  {
    id: "index-of-max",
    purpose: "find the index of the largest value, -1 when empty",
    names: { fn: ["indexOfMax", "argMax", "maxIndex"], xs: LIST },
    src: `
function $fn($xs: number[]): number {
  if ($xs.length === 0) {
    return -1;
  }
  let best = 0;
  for (let i = 1; i < $xs.length; i++) {
    if ($xs[i] > $xs[best]) {
      best = i;
    }
  }
  return best;
}`,
    input: (rng) => [ints(rng, int(rng, 1, 8), -9, 30)],
    edges: [[[]], [[7]], [[1, 9]], [[9, 1]], [[3, 3, 3]], [[1, 2, 8]]],
  },
  {
    id: "is-sorted",
    purpose: "tell whether a list is in ascending order",
    names: { fn: ["isSorted", "isAscending", "inOrder"], xs: LIST },
    src: `
function $fn($xs: number[]): boolean {
  for (let i = 1; i < $xs.length; i++) {
    if ($xs[i - 1] > $xs[i]) {
      return false;
    }
  }
  return true;
}`,
    input: (rng) => {
      const xs = ints(rng, int(rng, 2, 7), 0, 20);
      return [rng() < 0.5 ? sorted(xs) : xs];
    },
    edges: [
      [[]],
      [[1]],
      [[1, 1]],
      [[2, 1]],
      [[1, 2, 3]],
      [[1, 3, 2]],
      [[3, 1, 2]],
    ],
  },
  {
    id: "count-matches",
    purpose: "count how many values equal a target",
    names: {
      fn: ["countMatches", "countOf", "occurrences"],
      xs: LIST,
      t: ["target", "wanted", "needle"],
    },
    src: `
function $fn($xs: number[], $t: number): number {
  let count = 0;
  for (const x of $xs) {
    if (x === $t) {
      count++;
    }
  }
  return count;
}`,
    input: (rng) => [ints(rng, int(rng, 0, 8), 0, 4), int(rng, 0, 4)],
    edges: [
      [[], 1],
      [[1], 1],
      [[2], 1],
      [[1, 1, 2, 1], 1],
    ],
  },
  {
    id: "binary-search",
    purpose: "binary-search a sorted list, -1 when the value is absent",
    names: {
      fn: ["binarySearch", "findSorted", "search"],
      xs: ["sorted", "values", "keys"],
      t: ["target", "key", "wanted"],
    },
    src: `
function $fn($xs: number[], $t: number): number {
  let lo = 0;
  let hi = $xs.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ($xs[mid] === $t) {
      return mid;
    }
    if ($xs[mid] < $t) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}`,
    input: (rng) => {
      const xs = [...new Set(sorted(ints(rng, int(rng, 1, 9), 0, 30)))];
      return [xs, rng() < 0.7 ? pick(rng, xs) : int(rng, -2, 32)];
    },
    edges: [
      [[], 3],
      [[3], 3],
      [[3], 4],
      [[1, 3, 5, 7], 1],
      [[1, 3, 5, 7], 7],
      [[1, 3, 5, 7], 4],
      [[1, 3, 5, 7, 9], 5],
    ],
  },
  {
    id: "dedupe",
    purpose: "drop repeated values, keeping the first of each",
    names: { fn: ["dedupe", "unique", "distinct"], xs: LIST },
    src: `
function $fn($xs: number[]): number[] {
  const seen: number[] = [];
  for (const x of $xs) {
    if (!seen.includes(x)) {
      seen.push(x);
    }
  }
  return seen;
}`,
    input: (rng) => [ints(rng, int(rng, 0, 9), 0, 5)],
    edges: [[[]], [[1]], [[1, 1]], [[1, 2, 1, 3, 2]]],
  },
  {
    id: "average",
    purpose: "average a list, 0 when it is empty",
    names: {
      fn: ["average", "mean", "meanOf"],
      sum: ["sum", "total", "sumOf"],
      xs: LIST,
    },
    src: `
function $sum($xs: number[]): number {
  let acc = 0;
  for (const x of $xs) {
    acc += x;
  }
  return acc;
}

function $fn($xs: number[]): number {
  if ($xs.length === 0) {
    return 0;
  }
  return $sum($xs) / $xs.length;
}`,
    input: (rng) => {
      const n = int(rng, 1, 6);
      const xs = ints(rng, n, 0, 20);
      // Whole means keep the expected values readable.
      const rest = xs.slice(1).reduce((a, b) => a + b, 0);
      xs[0] = (xs[0] as number) + ((n - ((rest + (xs[0] as number)) % n)) % n);
      return [xs];
    },
    edges: [[[]], [[4]], [[2, 4]], [[1, 2, 3]], [[0, 0, 0, 8]]],
  },
  {
    id: "chunk",
    purpose: "split a list into chunks of a given size",
    names: {
      fn: ["chunk", "chunked", "inGroups"],
      xs: LIST,
      n: ["size", "width", "per"],
    },
    src: `
function $fn($xs: number[], $n: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < $xs.length; i += $n) {
    out.push($xs.slice(i, i + $n));
  }
  return out;
}`,
    input: (rng) => [ints(rng, int(rng, 0, 9), 0, 9), int(rng, 1, 4)],
    edges: [
      [[], 2],
      [[1], 1],
      [[1, 2, 3], 2],
      [[1, 2, 3, 4], 2],
      [[1, 2, 3], 5],
    ],
  },
  {
    id: "merge-sorted",
    purpose: "merge two sorted lists into one sorted list",
    names: { fn: ["mergeSorted", "merge", "mergeLists"] },
    src: `
function $fn(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] <= b[j]) {
      out.push(a[i]);
      i++;
    } else {
      out.push(b[j]);
      j++;
    }
  }
  while (i < a.length) {
    out.push(a[i]);
    i++;
  }
  while (j < b.length) {
    out.push(b[j]);
    j++;
  }
  return out;
}`,
    input: (rng) => [
      sorted(ints(rng, int(rng, 0, 5), 0, 20)),
      sorted(ints(rng, int(rng, 0, 5), 0, 20)),
    ],
    edges: [
      [[], []],
      [[1], []],
      [[], [2]],
      [
        [1, 4],
        [2, 3],
      ],
      [
        [1, 2],
        [3, 4],
      ],
      [
        [5, 6],
        [1, 2],
      ],
    ],
  },
  {
    id: "running-total",
    purpose: "running totals of a list",
    names: { fn: ["runningTotal", "cumulative", "prefixSums"], xs: LIST },
    src: `
function $fn($xs: number[]): number[] {
  const out: number[] = [];
  let total = 0;
  for (let i = 0; i < $xs.length; i++) {
    total += $xs[i];
    out.push(total);
  }
  return out;
}`,
    input: (rng) => [ints(rng, int(rng, 0, 7), -5, 15)],
    edges: [[[]], [[3]], [[1, 2, 3]], [[5, -5, 5]]],
  },
  {
    id: "run-length",
    purpose: "run-length encode a string: aaab becomes a3b1",
    names: {
      fn: ["runLength", "encodeRuns", "compress"],
      s: ["text", "input", "s"],
    },
    src: `
function $fn($s: string): string {
  let out = "";
  let i = 0;
  while (i < $s.length) {
    let j = i;
    while (j < $s.length && $s[j] === $s[i]) {
      j++;
    }
    out += $s[i] + (j - i);
    i = j;
  }
  return out;
}`,
    input: (rng) => [runs(rng)],
    edges: [[""], ["a"], ["aa"], ["ab"], ["aaabcc"]],
  },
  {
    id: "capitalize-words",
    purpose: "capitalize the first letter of every word",
    names: {
      fn: ["capitalizeWords", "titleCase", "capitalize"],
      s: ["text", "title", "s"],
    },
    src: `
function $fn($s: string): string {
  const words = $s.split(" ");
  const out: string[] = [];
  for (const w of words) {
    if (w.length === 0) {
      out.push(w);
      continue;
    }
    out.push(w[0].toUpperCase() + w.slice(1));
  }
  return out.join(" ");
}`,
    input: (rng) => [sentence(rng, int(rng, 1, 4))],
    edges: [[""], ["a"], ["fox"], ["red fox"], ["a  b"]],
  },
  {
    id: "leap-year",
    purpose: "tell whether a year is a leap year",
    names: { fn: ["isLeapYear", "leapYear", "isLeap"], y: ["year", "y"] },
    src: `
function $fn($y: number): boolean {
  if ($y % 400 === 0) {
    return true;
  }
  if ($y % 100 === 0) {
    return false;
  }
  return $y % 4 === 0;
}`,
    input: (rng) => [int(rng, 1890, 2110)],
    edges: [[2000], [1900], [2024], [2023], [2100], [2400]],
  },
  {
    id: "count-vowels",
    purpose: "count the vowels in a string",
    names: {
      fn: ["countVowels", "vowelCount", "vowels"],
      s: ["text", "word", "s"],
    },
    src: `
function $fn($s: string): number {
  let count = 0;
  for (const ch of $s.toLowerCase()) {
    if ("aeiou".includes(ch)) {
      count++;
    }
  }
  return count;
}`,
    input: (rng) => [sentence(rng, int(rng, 1, 3))],
    edges: [[""], ["a"], ["xyz"], ["Ocean"], ["AEIOU"]],
  },
  {
    id: "max-subarray",
    purpose: "the largest sum of a contiguous run, 0 when empty",
    names: { fn: ["maxSubarraySum", "bestRun", "maxRunSum"], xs: LIST },
    src: `
function $fn($xs: number[]): number {
  if ($xs.length === 0) {
    return 0;
  }
  let best = $xs[0];
  let current = $xs[0];
  for (let i = 1; i < $xs.length; i++) {
    current = Math.max($xs[i], current + $xs[i]);
    best = Math.max(best, current);
  }
  return best;
}`,
    input: (rng) => [ints(rng, int(rng, 1, 8), -9, 9)],
    edges: [[[]], [[-3]], [[2, -1, 2]], [[-2, -1]], [[1, -5, 4, 3]]],
  },
  {
    id: "rotate-left",
    purpose: "rotate a list left by k places",
    names: {
      fn: ["rotateLeft", "rotate", "shiftLeft"],
      xs: LIST,
      k: ["k", "steps", "by"],
    },
    src: `
function $fn($xs: number[], $k: number): number[] {
  if ($xs.length === 0) {
    return [];
  }
  const shift = $k % $xs.length;
  return $xs.slice(shift).concat($xs.slice(0, shift));
}`,
    input: (rng) => [ints(rng, int(rng, 1, 7), 0, 9), int(rng, 0, 10)],
    edges: [
      [[], 2],
      [[1], 3],
      [[1, 2, 3], 0],
      [[1, 2, 3], 1],
      [[1, 2, 3], 3],
      [[1, 2, 3], 4],
    ],
  },
  {
    id: "second-largest",
    purpose: "the second-largest distinct value, null when there is none",
    names: { fn: ["secondLargest", "runnerUp", "secondMax"], xs: LIST },
    src: `
function $fn($xs: number[]): number | null {
  let first = -Infinity;
  let second = -Infinity;
  for (const x of $xs) {
    if (x > first) {
      second = first;
      first = x;
    } else if (x < first && x > second) {
      second = x;
    }
  }
  return second === -Infinity ? null : second;
}`,
    input: (rng) => [ints(rng, int(rng, 0, 7), 0, 12)],
    edges: [
      [[]],
      [[4]],
      [[4, 4]],
      [[1, 2]],
      [[2, 1]],
      [[5, 5, 3]],
      [[3, 9, 7]],
    ],
  },
  {
    id: "fizz-buzz",
    purpose: "FizzBuzz for one number",
    names: { fn: ["fizzBuzz", "fizz", "say"], n: ["n", "num", "i"] },
    src: `
function $fn($n: number): string {
  if ($n % 15 === 0) {
    return "FizzBuzz";
  } else if ($n % 3 === 0) {
    return "Fizz";
  } else if ($n % 5 === 0) {
    return "Buzz";
  }
  return "" + $n;
}`,
    input: (rng) => [int(rng, 1, 60)],
    edges: [[1], [3], [5], [15], [30], [7]],
  },
  {
    id: "page-size",
    purpose: "how many items a page shows, pages counted from 1",
    names: {
      fn: ["itemsOnPage", "pageSize", "pageCount"],
      per: ["perPage", "pageLength", "limit"],
    },
    src: `
function $fn(total: number, $per: number, page: number): number {
  const start = (page - 1) * $per;
  if (page < 1 || start >= total) {
    return 0;
  }
  return Math.min($per, total - start);
}`,
    input: (rng) => [int(rng, 0, 45), int(rng, 1, 10), int(rng, 0, 6)],
    edges: [
      [0, 10, 1],
      [10, 10, 1],
      [10, 10, 2],
      [11, 10, 2],
      [25, 10, 3],
      [25, 10, 0],
    ],
  },
  {
    id: "reverse-words",
    purpose: "reverse the order of the words in a sentence",
    names: {
      fn: ["reverseWords", "wordsBackwards", "flipWords"],
      s: ["text", "sentence", "s"],
    },
    src: `
function $fn($s: string): string {
  const words = $s.split(" ");
  const out: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    out.push(words[i]);
  }
  return out.join(" ");
}`,
    input: (rng) => [sentence(rng, int(rng, 1, 5))],
    edges: [[""], ["fox"], ["red fox"], ["a b c"]],
  },
  {
    id: "palindrome",
    purpose: "tell whether a string reads the same backwards",
    names: {
      fn: ["isPalindrome", "palindrome", "readsBackwards"],
      s: ["text", "word", "s"],
    },
    src: `
function $fn($s: string): boolean {
  let left = 0;
  let right = $s.length - 1;
  while (left < right) {
    if ($s[left] !== $s[right]) {
      return false;
    }
    left++;
    right--;
  }
  return true;
}`,
    input: (rng) => [
      rng() < 0.5
        ? pick(rng, ["level", "noon", "abba", "racecar", "aba"])
        : word(rng),
    ],
    edges: [[""], ["a"], ["ab"], ["aa"], ["abca"], ["abcba"]],
  },
  {
    id: "median",
    purpose: "the median of a list, null when it is empty",
    names: {
      fn: ["median", "middleValue", "medianOf"],
      sort: ["sortedCopy", "sortAscending", "inOrder"],
      xs: LIST,
    },
    src: `
function $sort($xs: number[]): number[] {
  const out = $xs.slice();
  for (let i = 1; i < out.length; i++) {
    let j = i;
    while (j > 0 && out[j - 1] > out[j]) {
      const tmp = out[j];
      out[j] = out[j - 1];
      out[j - 1] = tmp;
      j--;
    }
  }
  return out;
}

function $fn($xs: number[]): number | null {
  if ($xs.length === 0) {
    return null;
  }
  const s = $sort($xs);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) {
    return s[mid];
  }
  return (s[mid - 1] + s[mid]) / 2;
}`,
    input: (rng) => {
      const xs = ints(rng, int(rng, 1, 7), 0, 20).map((x) => x * 2);
      return [xs];
    },
    edges: [[[]], [[5]], [[4, 2]], [[3, 1, 2]], [[8, 2, 6, 4]]],
  },
  {
    id: "count-in-range",
    purpose: "count the values inside a closed range",
    names: {
      fn: ["countInRange", "countBetween", "inRangeCount"],
      within: ["inRange", "within", "isBetween"],
      xs: LIST,
    },
    src: `
function $within(x: number, lo: number, hi: number): boolean {
  return x >= lo && x <= hi;
}

function $fn($xs: number[], lo: number, hi: number): number {
  let count = 0;
  for (const x of $xs) {
    if ($within(x, lo, hi)) {
      count++;
    }
  }
  return count;
}`,
    input: (rng) => {
      const lo = int(rng, 0, 10);
      return [ints(rng, int(rng, 0, 8), 0, 20), lo, lo + int(rng, 0, 8)];
    },
    edges: [
      [[], 0, 5],
      [[5], 5, 5],
      [[4, 5, 6], 5, 5],
      [[0, 10], 0, 10],
      [[1, 2, 3], 4, 9],
    ],
  },
  {
    id: "grade",
    purpose: "the letter grade for a score out of 100",
    names: {
      fn: ["gradeFor", "letterGrade", "grade"],
      s: ["score", "points", "mark"],
    },
    src: `
function $fn($s: number): string {
  if ($s >= 90) {
    return "A";
  } else if ($s >= 80) {
    return "B";
  } else if ($s >= 70) {
    return "C";
  } else if ($s >= 60) {
    return "D";
  }
  return "F";
}`,
    input: (rng) => [int(rng, 40, 100)],
    edges: [[90], [89], [80], [79], [70], [60], [59], [100]],
  },
  {
    id: "digit-sum",
    purpose: "the sum of the decimal digits of a whole number",
    names: {
      fn: ["digitSum", "sumDigits", "digitTotal"],
      n: ["n", "num", "value"],
    },
    src: `
function $fn($n: number): number {
  let rest = Math.abs($n);
  let sum = 0;
  while (rest > 0) {
    sum += rest % 10;
    rest = Math.floor(rest / 10);
  }
  return sum;
}`,
    input: (rng) => [int(rng, -999, 99999)],
    edges: [[0], [7], [10], [-45], [909]],
  },
  {
    id: "longest-run",
    purpose: "the length of the longest run of equal neighbours",
    names: { fn: ["longestRun", "longestStreak", "maxRun"], xs: LIST },
    src: `
function $fn($xs: number[]): number {
  if ($xs.length === 0) {
    return 0;
  }
  let best = 1;
  let run = 1;
  for (let i = 1; i < $xs.length; i++) {
    if ($xs[i] === $xs[i - 1]) {
      run++;
      best = Math.max(best, run);
    } else {
      run = 1;
    }
  }
  return best;
}`,
    input: (rng) => [ints(rng, int(rng, 1, 9), 0, 2)],
    edges: [
      [[]],
      [[1]],
      [[1, 1]],
      [[1, 2]],
      [[1, 2, 2, 2, 1]],
      [[3, 3, 1, 3, 3, 3]],
    ],
  },
  {
    id: "truncate",
    purpose: "shorten text to a maximum length, ending in ...",
    names: {
      fn: ["truncate", "shorten", "ellipsize"],
      s: ["text", "title", "s"],
      n: ["max", "limit", "width"],
    },
    src: `
function $fn($s: string, $n: number): string {
  if ($s.length <= $n) {
    return $s;
  }
  return $s.slice(0, $n - 3) + "...";
}`,
    input: (rng) => [sentence(rng, int(rng, 1, 4)), int(rng, 4, 14)],
    edges: [
      ["", 5],
      ["abcde", 5],
      ["abcdef", 5],
      ["harbor line", 8],
    ],
  },
  {
    id: "range-span",
    purpose: "the gap between the largest and smallest value, 0 when empty",
    names: {
      fn: ["rangeSpan", "spread", "valueRange"],
      lo: ["minOf", "smallest", "lowest"],
      hi: ["maxOf", "largest", "highest"],
      xs: LIST,
    },
    src: `
function $lo($xs: number[]): number {
  let m = $xs[0];
  for (const x of $xs) {
    if (x < m) {
      m = x;
    }
  }
  return m;
}

function $hi($xs: number[]): number {
  let m = $xs[0];
  for (const x of $xs) {
    if (x > m) {
      m = x;
    }
  }
  return m;
}

function $fn($xs: number[]): number {
  if ($xs.length === 0) {
    return 0;
  }
  return $hi($xs) - $lo($xs);
}`,
    input: (rng) => [ints(rng, int(rng, 1, 7), -10, 25)],
    edges: [[[]], [[4]], [[2, 9]], [[9, 2]], [[-3, 0, 3]]],
  },
];

export const templateById = (id: string): Template | undefined =>
  TEMPLATES.find((t) => t.id === id);

/** A template written out with names drawn by `rng`. */
export interface Instance {
  template: Template;
  module: Module;
  /** The exported function's name. */
  fn: string;
  /** The hole choices, `fn` among them. */
  names: Record<string, string>;
}

export function instantiate(template: Template, rng: Rng): Instance {
  const names: Record<string, string> = {};
  for (const [hole, choices] of Object.entries(template.names))
    names[hole] = pick(rng, choices);
  // Longest holes first, so `$xs` never eats the start of a longer hole.
  const holes = Object.keys(names).sort((a, b) => b.length - a.length);
  let src = template.src;
  for (const hole of holes)
    src = src.replaceAll(`$${hole}`, names[hole] as string);
  if (src.includes("$")) throw new Error(`${template.id} has an unfilled hole`);
  return {
    template,
    module: parseModule(src),
    fn: names.fn as string,
    names,
  };
}

/** Helpers: a template with more than one function, so a bug can hide one call away. */
export const withHelpers = (): Template[] =>
  TEMPLATES.filter((t) => (t.src.match(/^function /gm) ?? []).length > 1);
