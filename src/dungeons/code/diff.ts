// Unified diff generator for code comparisons and PR diffs. Pure,
// deterministic, with standard hunk headers (@@ -l,s +l,s @@).

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Standard LCS line diff */
function lcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i < m; i++) {
    const rowCurrent = dp[i] ?? [];
    const rowNext = dp[i + 1] ?? [];
    for (let j = 0; j < n; j++) {
      if (a[i] === b[j]) {
        rowNext[j + 1] = (rowCurrent[j] ?? 0) + 1;
      } else {
        rowNext[j + 1] = Math.max(rowNext[j] ?? 0, (dp[i] ?? [])[j + 1] ?? 0);
      }
    }
  }
  return dp;
}

type Edit =
  | { type: "keep"; line: string }
  | { type: "del"; line: string }
  | { type: "add"; line: string };

function computeEdits(a: string[], b: string[]): Edit[] {
  const dp = lcs(a, b);
  let i = a.length;
  let j = b.length;
  const edits: Edit[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      edits.push({ type: "keep", line: a[i - 1] as string });
      i--;
      j--;
    } else if (
      j > 0 &&
      (i === 0 || (dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0))
    ) {
      edits.push({ type: "add", line: b[j - 1] as string });
      j--;
    } else if (i > 0) {
      edits.push({ type: "del", line: a[i - 1] as string });
      i--;
    }
  }
  return edits.reverse();
}

/**
 * Computes a unified diff between oldText and newText.
 * If context is 3, up to 3 lines of surrounding context are shown per hunk.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  file = "src/index.ts",
  context = 3,
): string {
  const a = oldText.endsWith("\n")
    ? oldText.slice(0, -1).split("\n")
    : oldText
      ? oldText.split("\n")
      : [];
  const b = newText.endsWith("\n")
    ? newText.slice(0, -1).split("\n")
    : newText
      ? newText.split("\n")
      : [];
  const edits = computeEdits(a, b);

  // Group edits into hunks with context
  const hunks: DiffHunk[] = [];
  let curHunk: DiffHunk | null = null;
  let oldLine = 1;
  let newLine = 1;

  let lastChangeIndex = -Infinity;

  for (let idx = 0; idx < edits.length; idx++) {
    const edit = edits[idx] as Edit;
    const isChange = edit.type !== "keep";

    if (isChange) {
      const startContext = Math.max(0, idx - context);
      if (!curHunk || idx - lastChangeIndex > context * 2) {
        // Start new hunk
        if (curHunk) hunks.push(curHunk);
        curHunk = {
          oldStart:
            oldLine -
            (idx -
              Math.max(
                startContext,
                lastChangeIndex + 1 > 0 ? lastChangeIndex + 1 : 0,
              )),
          oldLines: 0,
          newStart:
            newLine -
            (idx -
              Math.max(
                startContext,
                lastChangeIndex + 1 > 0 ? lastChangeIndex + 1 : 0,
              )),
          newLines: 0,
          lines: [],
        };
        // Add leading context
        const from = Math.max(
          startContext,
          lastChangeIndex + 1 > 0 ? lastChangeIndex + 1 : 0,
        );
        for (let c = from; c < idx; c++) {
          const line = edits[c]?.line ?? "";
          curHunk.lines.push(` ${line}`);
          curHunk.oldLines++;
          curHunk.newLines++;
        }
      } else {
        // Add intervening context between nearby changes
        for (let c = lastChangeIndex + 1; c < idx; c++) {
          const line = edits[c]?.line ?? "";
          curHunk.lines.push(` ${line}`);
          curHunk.oldLines++;
          curHunk.newLines++;
        }
      }

      if (edit.type === "del") {
        curHunk.lines.push(`-${edit.line}`);
        curHunk.oldLines++;
        oldLine++;
      } else {
        curHunk.lines.push(`+${edit.line}`);
        curHunk.newLines++;
        newLine++;
      }
      lastChangeIndex = idx;
    } else {
      if (curHunk && idx - lastChangeIndex <= context) {
        curHunk.lines.push(` ${edit.line}`);
        curHunk.oldLines++;
        curHunk.newLines++;
      }
      oldLine++;
      newLine++;
    }
  }

  if (curHunk) {
    hunks.push(curHunk);
  }

  if (!hunks.length) {
    return "";
  }

  const header = `--- a/${file}\n+++ b/${file}\n`;
  const body = hunks
    .map((h) => {
      return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`;
    })
    .join("\n");

  return `${header}${body}\n`;
}
