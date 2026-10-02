// A tiny element builder. Text always goes in as text nodes, so nothing a
// decider or a request says is ever parsed as HTML.

import { createElement, type IconNode } from "lucide";

export type Child = Node | string | number | null | undefined | false | Child[];

type Props = Record<
  string,
  string | number | boolean | null | undefined | ((event: Event) => void)
>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      el.className = String(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else if (key === "value" && "value" in el) {
      (el as HTMLInputElement).value = String(value);
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else
      parent.appendChild(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  }
}

export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

export function icon(node: IconNode, label?: string): SVGElement {
  const svg = createElement(node);
  svg.setAttribute("aria-hidden", label ? "false" : "true");
  if (label) svg.setAttribute("aria-label", label);
  return svg;
}

const SVG = "http://www.w3.org/2000/svg";

export function svg(
  tag: string,
  attrs: Record<string, string | number> = {},
  ...children: (SVGElement | null)[]
): SVGElement {
  const el = document.createElementNS(SVG, tag) as SVGElement;
  for (const [key, value] of Object.entries(attrs))
    el.setAttribute(key, String(value));
  for (const child of children) if (child) el.appendChild(child);
  return el;
}

/** Milliseconds, with a decimal below 10 so a 0.1 ms step does not read as 0. */
export const ms = (value: number | undefined): string =>
  value === undefined
    ? "—"
    : `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;

export const percent = (p: number): string => `${Math.round(p * 100)}%`;
