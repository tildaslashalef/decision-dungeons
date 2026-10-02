// The route map: roads, the planned route in blue, traffic, the
// destination flag, and the car always pointing up. Drag to pan, scroll or
// the buttons to zoom, double-click to follow the car again; the panel
// itself can be dragged anywhere on screen.

import { Grip, Minus, Plus, RotateCcw } from "lucide";
import { h, icon } from "../../../ui/dom.ts";
import { clamp, last, type Point } from "../world/geometry.ts";
import type { Junction } from "../world/types.ts";
import type { SceneSource } from "./playback.ts";

const W = 380;
const H = 310;

interface MapView {
  center: Point;
  heading: number;
  scale: number;
}

export class Minimap {
  readonly element: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private zoom = 1;
  private center: Point | null = null;
  private heading: number | null = null;
  private position: { left: number; top: number } | null = null;
  private zoomIn: HTMLButtonElement;
  private zoomOut: HTMLButtonElement;
  private events = new AbortController();
  private lastDraw = 0;

  constructor(private sim: () => SceneSource) {
    this.canvas = h("canvas", {
      width: W,
      height: H,
      "aria-label":
        "Route map. Drag to pan, scroll to zoom, double-click to follow the car.",
    });
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
    const grip = h(
      "button",
      {
        type: "button",
        class: "map-drag",
        "aria-label": "Move minimap",
        title: "Move minimap · drag or arrow keys",
      },
      icon(Grip),
    );
    this.zoomOut = h(
      "button",
      { type: "button", "aria-label": "Zoom out", title: "Zoom out" },
      icon(Minus),
    );
    this.zoomIn = h(
      "button",
      { type: "button", "aria-label": "Zoom in", title: "Zoom in" },
      icon(Plus),
    );
    const reset = h(
      "button",
      {
        type: "button",
        "aria-label": "Reset minimap",
        title: "Reset position, zoom, and following",
      },
      icon(RotateCcw),
    );
    this.element = h(
      "div",
      { class: "dd-minimap dd-glass" },
      h(
        "div",
        {
          class: "minimap-toolbar",
          role: "toolbar",
          "aria-label": "Minimap controls",
        },
        grip,
        h("div", {}, this.zoomOut, this.zoomIn, reset),
      ),
      this.canvas,
    );
    const signal = this.events.signal;
    this.zoomIn.addEventListener(
      "click",
      () => this.setZoom(this.zoom * 1.25),
      { signal },
    );
    this.zoomOut.addEventListener(
      "click",
      () => this.setZoom(this.zoom / 1.25),
      { signal },
    );
    reset.addEventListener(
      "click",
      () => {
        this.position = null;
        for (const property of ["position", "left", "top", "bottom"])
          this.element.style.removeProperty(property);
        this.resetView();
      },
      { signal },
    );
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.setZoom(
          this.zoom * Math.exp(-clamp(event.deltaY, -100, 100) * 0.005),
        );
      },
      { passive: false, signal },
    );
    this.canvas.addEventListener("dblclick", () => this.resetView(), {
      signal,
    });
    this.drag(
      grip,
      () => {
        const { left, top } = this.element.getBoundingClientRect();
        return { left, top };
      },
      (start, dx, dy) => this.movePanel(start.left + dx, start.top + dy),
      "is-moving",
    );
    this.drag(
      this.canvas,
      () => ({ view: this.view(), rect: this.canvas.getBoundingClientRect() }),
      (start, dx, dy) => {
        const x = (dx * W) / start.rect.width / start.view.scale;
        const z = (dy * H) / start.rect.height / start.view.scale;
        const c = Math.cos(start.view.heading);
        const s = Math.sin(start.view.heading);
        this.center = {
          x: start.view.center.x - (x * c - z * s),
          z: start.view.center.z - (x * s + z * c),
        };
        this.heading = start.view.heading;
        this.draw();
      },
      "is-panning",
    );
    grip.addEventListener(
      "keydown",
      (event) => {
        const direction = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        }[event.key];
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = this.element.getBoundingClientRect();
        const step = event.shiftKey ? 1 : 10;
        this.movePanel(
          rect.left + (direction[0] as number) * step,
          rect.top + (direction[1] as number) * step,
        );
      },
      { signal },
    );
    window.addEventListener("resize", () => this.constrain(), { signal });
  }

  private drag<S extends object>(
    handle: HTMLElement,
    start: () => S,
    move: (state: S, dx: number, dy: number) => void,
    className: string,
  ): void {
    const signal = this.events.signal;
    let state:
      | (S & { id: number; x: number; y: number; moved?: boolean })
      | null = null;
    handle.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        state = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          ...start(),
        };
        handle.setPointerCapture(event.pointerId);
        this.element.classList.add(className);
      },
      { signal },
    );
    handle.addEventListener(
      "pointermove",
      (event) => {
        if (!state || state.id !== event.pointerId) return;
        const dx = event.clientX - state.x;
        const dy = event.clientY - state.y;
        if (Math.hypot(dx, dy) < 3 && !state.moved) return;
        state.moved = true;
        move(state, dx, dy);
      },
      { signal },
    );
    const finish = (event: PointerEvent) => {
      if (state?.id !== event.pointerId) return;
      state = null;
      this.element.classList.remove(className);
      if (handle.hasPointerCapture(event.pointerId))
        handle.releasePointerCapture(event.pointerId);
    };
    for (const type of [
      "pointerup",
      "pointercancel",
      "lostpointercapture",
    ] as const)
      handle.addEventListener(type, finish, { signal });
  }

  private view(): MapView {
    const sim = this.sim();
    const player = sim.player;
    return {
      center: this.center ? { ...this.center } : { x: player.x, z: player.z },
      heading: this.heading ?? player.heading,
      scale: (sim.world.type === "highway" ? 0.85 : 1.35) * this.zoom,
    };
  }

  private setZoom(value: number): void {
    this.zoom = clamp(value, 0.35, 4);
    this.zoomIn.disabled = this.zoom >= 4;
    this.zoomOut.disabled = this.zoom <= 0.35;
    this.draw();
  }

  resetView(): void {
    this.center = this.heading = null;
    this.setZoom(1);
  }

  private movePanel(left: number, top: number): void {
    const rect = this.element.getBoundingClientRect();
    this.position = {
      left: clamp(left, 8, Math.max(8, innerWidth - rect.width - 8)),
      top: clamp(top, 8, Math.max(8, innerHeight - rect.height - 8)),
    };
    this.element.style.position = "fixed";
    this.element.style.left = `${this.position.left}px`;
    this.element.style.top = `${this.position.top}px`;
    this.element.style.bottom = "auto";
  }

  constrain(): void {
    if (this.position && !this.element.hidden)
      this.movePanel(this.position.left, this.position.top);
  }

  /** Redraws at most ten times a second unless forced. */
  update(now: number): void {
    if (this.element.hidden || now - this.lastDraw < 100) return;
    this.lastDraw = now;
    this.draw();
  }

  draw(): void {
    const sim = this.sim();
    const w = sim.world;
    const v = sim.player;
    const map = this.ctx;
    const view = this.view();
    const scale = view.scale;
    const pt = (p: Point): [number, number] => [
      (p.x - view.center.x) * scale,
      (p.z - view.center.z) * scale,
    ];
    const line = (points: Point[]) => {
      map.beginPath();
      points.forEach((p, i) => {
        if (i) map.lineTo(...pt(p));
        else map.moveTo(...pt(p));
      });
      map.stroke();
    };
    map.clearRect(0, 0, W, H);
    map.fillStyle = "#f3f4f6";
    map.fillRect(0, 0, W, H);
    map.save();
    map.translate(W / 2, H * 0.65);
    map.rotate(-view.heading);
    map.lineCap = "round";
    map.strokeStyle = "#d0d3d8";
    if (w.roadSamples) {
      map.lineWidth = 25 * scale;
      line(w.roadSamples);
    }
    if (w.connectorRoads)
      for (const road of w.connectorRoads) {
        map.lineWidth = road.width * scale;
        line(road.points);
      }
    else if (!w.roadSamples)
      for (const e of w.edges) {
        map.lineWidth = e.width * scale;
        line([w.byId[e.a] as Junction, w.byId[e.b] as Junction]);
      }
    map.strokeStyle = "#3e6ae1";
    map.lineWidth = 4;
    line(v.route.points);
    for (const car of sim.traffic) {
      map.fillStyle = car.type === "motorcycle" ? "#e82127" : "#81858d";
      map.beginPath();
      map.arc(...pt(car), 4, 0, Math.PI * 2);
      map.fill();
    }
    const end = pt(last(v.route.points));
    map.fillStyle = "#171a20";
    map.fillRect(end[0] - 3, end[1] - 6, 8, 7);
    map.fillRect(end[0] - 3, end[1] - 6, 1, 14);
    map.save();
    map.translate(...pt(v));
    map.rotate(v.heading);
    map.fillStyle = "#ffffff";
    map.beginPath();
    map.arc(0, 0, 13, 0, Math.PI * 2);
    map.fill();
    map.fillStyle = "#171a20";
    map.beginPath();
    map.moveTo(0, -10);
    map.lineTo(7, 7);
    map.lineTo(0, 4);
    map.lineTo(-7, 7);
    map.closePath();
    map.fill();
    map.restore();
    map.restore();
  }

  dispose(): void {
    this.events.abort();
  }
}
