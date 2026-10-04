// The Bugfix Workbench browser view: an interactive developer console with
// source tabs, syntax-highlighted diffs for candidate patches, a test
// execution runner panel, and a timeline of agent debugging actions.

import { h } from "../../ui/dom.ts";
import type { PlayStatus } from "../../ui/store.ts";
import type { Browse } from "../../ui/views.ts";
import { printModule } from "../code/print.ts";
import type { BugfixRun, CandidatePatch } from "./bugfix.ts";

function renderDiff(diffText: string): HTMLElement {
  const pre = h("pre", { class: "doc-code" });
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      pre.appendChild(h("span", { class: "diff-add" }, line, "\n"));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      pre.appendChild(h("span", { class: "diff-del" }, line, "\n"));
    } else if (line.startsWith("@@")) {
      pre.appendChild(h("span", { class: "diff-hunk" }, line, "\n"));
    } else {
      pre.appendChild(document.createTextNode(`${line}\n`));
    }
  }
  return pre;
}

function renderCode(code: string): HTMLElement {
  return h("pre", { class: "doc-code" }, code);
}

function renderPatchCard(patch: CandidatePatch): HTMLElement {
  return h(
    "div",
    { class: "workbench-patch-card" },
    h(
      "div",
      { class: "workbench-patch-header" },
      h("strong", {}, patch.id),
      h("span", { class: "workbench-patch-summary" }, `: ${patch.summary}`),
    ),
    renderDiff(patch.diff),
  );
}

export function bugfixView(
  run: BugfixRun,
  _status: PlayStatus,
  _browse: Browse,
): HTMLElement {
  const container = h("div", { class: "workbench-container" });

  // 1. Header Bar: Level, Turn Counter, Function Tabs, Status
  const header = h("div", { class: "workbench-header" });
  const meta = h(
    "div",
    { class: "workbench-meta" },
    h("span", { class: "workbench-title" }, run.level.title),
    h("span", { class: "workbench-turn" }, `Turn ${run.turn}/${run.maxTurns}`),
    h(
      "span",
      {
        class: `workbench-badge ${run.finished ? (run.passed ? "badge-pass" : "badge-fail") : "badge-active"}`,
      },
      run.finished
        ? run.passed
          ? "PASSED"
          : "FAILED"
        : run.undoStack.length > 0
          ? "MODIFIED"
          : "READY",
    ),
  );
  header.appendChild(meta);

  // Function Tabs
  const tabs = h("div", { class: "workbench-tabs" });
  for (const fn of run.functions) {
    const isInspected = fn === run.inspectedFn;
    const tab = h(
      "button",
      {
        class: `workbench-tab ${isInspected ? "active" : ""}`,
        onClick: () => {
          run.inspectedFn = fn;
        },
      },
      `${fn}.ts`,
    );
    tabs.appendChild(tab);
  }
  header.appendChild(tabs);
  container.appendChild(header);

  // 2. Main Workbench Grid
  const grid = h("div", { class: "workbench-grid" });

  // Left Column: Source Editor & Candidate Patches
  const editorCol = h("div", { class: "workbench-editor-col" });

  const activeFn = run.inspectedFn
    ? run.workspace.fns.find((f) => f.name === run.inspectedFn)
    : run.workspace.fns[0];
  const activeCode = activeFn
    ? printModule({ fns: [activeFn] }).text
    : "// No function inspected";

  const sourceCard = h(
    "div",
    { class: "workbench-card" },
    h(
      "div",
      { class: "workbench-card-title" },
      `Source: ${run.inspectedFn ?? activeFn?.name ?? "module"}.ts`,
    ),
    renderCode(activeCode),
  );
  editorCol.appendChild(sourceCard);

  // Patches section
  if (run.availablePatches.length > 0) {
    const patchesCard = h(
      "div",
      { class: "workbench-card" },
      h(
        "div",
        { class: "workbench-card-title" },
        `Available Candidate Patches (${run.availablePatches.length})`,
      ),
    );
    for (const p of run.availablePatches) {
      patchesCard.appendChild(renderPatchCard(p));
    }
    editorCol.appendChild(patchesCard);
  }

  grid.appendChild(editorCol);

  // Right Column: Test Runner Console & Turn Log
  const consoleCol = h("div", { class: "workbench-console-col" });

  // Test Runner Card
  const testCard = h("div", { class: "workbench-card" });
  const testHeader = h(
    "div",
    { class: "workbench-card-title" },
    "Test Suite Console",
  );
  testCard.appendChild(testHeader);

  if (run.lastTestResults) {
    const res = run.lastTestResults;
    const statBadge = h(
      "div",
      {
        class: `test-summary-badge ${res.failed === 0 ? "pass" : "fail"}`,
      },
      `${res.passed}/${res.total} tests passing`,
    );
    testCard.appendChild(statBadge);

    if (res.failures.length > 0) {
      const failureList = h("div", { class: "test-failures-list" });
      for (const f of res.failures) {
        failureList.appendChild(
          h(
            "div",
            { class: "doc-test-card" },
            h("div", { class: "test-call" }, `✗ ${f.call}`),
            h("div", {}, `  Expected: ${f.expected}`),
            h("div", {}, `  Actual:   ${f.actual}`),
          ),
        );
      }
      testCard.appendChild(failureList);
    }
  } else {
    testCard.appendChild(
      h(
        "div",
        { class: "workbench-placeholder" },
        "Tests not yet executed on current workspace.",
      ),
    );
  }
  consoleCol.appendChild(testCard);

  // Timeline / Action Log Card
  if (run.records.length > 0) {
    const timelineCard = h(
      "div",
      { class: "workbench-card" },
      h("div", { class: "workbench-card-title" }, "Agent Action Timeline"),
    );
    const timelineList = h("ul", { class: "workbench-timeline" });
    for (const r of run.records) {
      const item = h(
        "li",
        { class: `timeline-item ${r.correct ? "ok" : "err"}` },
        h("span", { class: "timeline-index" }, `T${r.index + 1}: `),
        h("span", { class: "timeline-summary" }, r.summary),
      );
      timelineList.appendChild(item);
    }
    timelineCard.appendChild(timelineList);
    consoleCol.appendChild(timelineCard);
  }

  grid.appendChild(consoleCol);
  container.appendChild(grid);

  return container;
}
