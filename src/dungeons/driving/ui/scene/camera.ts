// Pointer and wheel control of the camera: orbit and zoom in chase and
// bird's-eye views, look around from the driver's seat. Double-click resets.

import { clamp } from "../../world/geometry.ts";

export type CameraMode = "chase" | "hood" | "map";

export interface View {
  yaw: number;
  pitch: number;
  distance: number;
}

export class CameraInput {
  private states!: Record<CameraMode, View>;
  private events = new AbortController();

  constructor(
    canvas: HTMLCanvasElement,
    private readonly mode: () => CameraMode,
  ) {
    this.reset();
    const signal = this.events.signal;
    let pointer: { id: number; x: number; y: number } | null = null;
    canvas.style.touchAction = "none";
    canvas.style.cursor = "grab";
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 && event.button !== 2) return;
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = "grabbing";
      },
      { signal },
    );
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (!pointer || event.pointerId !== pointer.id) return;
        const dx = event.clientX - pointer.x;
        const dy = event.clientY - pointer.y;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        const state = this.current();
        if (this.mode() === "hood") {
          state.yaw = clamp(state.yaw + dx * 0.004, -2.1, 2.1);
          state.pitch = clamp(state.pitch - dy * 0.003, -0.65, 0.65);
        } else {
          state.yaw += dx * 0.005;
          state.pitch = clamp(state.pitch + dy * 0.004, 0.15, 1.48);
        }
      },
      { signal },
    );
    const release = () => {
      pointer = null;
      canvas.style.cursor = "grab";
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
      canvas.addEventListener(type, release, { signal });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault(), {
      signal,
    });
    canvas.addEventListener(
      "wheel",
      (event) => {
        if (this.mode() === "hood") return;
        event.preventDefault();
        const state = this.current();
        const map = this.mode() === "map";
        state.distance = clamp(
          state.distance * Math.exp(event.deltaY * 0.001),
          map ? 25 : 6,
          map ? 220 : 60,
        );
      },
      { passive: false, signal },
    );
    canvas.addEventListener("dblclick", () => this.reset(), { signal });
  }

  current(): View {
    return this.states[this.mode()];
  }

  reset(): void {
    this.states = {
      chase: { yaw: 0, pitch: 0.48, distance: 20 },
      map: { yaw: 0, pitch: 1.25, distance: 150 },
      hood: { yaw: 0, pitch: 0, distance: 0 },
    };
  }

  dispose(): void {
    this.events.abort();
  }
}
