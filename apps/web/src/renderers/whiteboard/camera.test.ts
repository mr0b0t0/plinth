// The camera: screen and board points map both ways, zoom stays from 10% to 400% and keeps the
// point under the pointer still, fit shows the whole board at no more than 100%, and each viewer's
// camera is kept in localStorage inside try/catch (a private window or a thumbnail capture can
// throw), with anything stored that is not a camera ignored.
import { describe, expect, it } from "vitest";
import {
  center,
  fitCamera,
  loadCamera,
  MAX_ZOOM,
  MIN_ZOOM,
  panBy,
  saveCamera,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from "./camera.ts";

const KEY = "plinth-whiteboard-camera";

function storageWindow() {
  const store = new Map<string, string>();
  const win = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
  } as unknown as Window;
  return { store, win };
}

describe("camera", () => {
  it("maps screen and board points both ways", () => {
    const c = { x: 100, y: 50, zoom: 2 };
    expect(screenToWorld(c, 20, 10)).toEqual({ x: 110, y: 55 });
    expect(worldToScreen(c, 110, 55)).toEqual({ x: 20, y: 10 });
    const p = worldToScreen(c, -37, 412);
    expect(screenToWorld(c, p.x, p.y)).toEqual({ x: -37, y: 412 });
    expect(center(c, 400, 200)).toEqual({ x: 200, y: 100 });
  });

  it("zooms about a point, within 0.1 and 4", () => {
    expect([MIN_ZOOM, MAX_ZOOM]).toEqual([0.1, 4]);
    const c = zoomAt({ x: 0, y: 0, zoom: 1 }, 200, 100, 2);
    expect(c.zoom).toBe(2);
    expect(screenToWorld(c, 200, 100)).toEqual({ x: 200, y: 100 });
    // Clamped, the point under the pointer still stays put.
    const max = zoomAt(c, 50, 30, 100);
    expect(max.zoom).toBe(4);
    expect(screenToWorld(max, 50, 30)).toEqual(screenToWorld(c, 50, 30));
    const min = zoomAt(c, 0, 0, 0.0001);
    expect(min.zoom).toBe(0.1);
    expect(screenToWorld(min, 0, 0)).toEqual(screenToWorld(c, 0, 0));
    expect(panBy({ x: 0, y: 0, zoom: 2 }, 10, -20)).toEqual({ x: -5, y: 10, zoom: 2 });
  });

  it("fits the board in the viewport, never above 100%", () => {
    expect(fitCamera({ x: 0, y: 0, w: 100, h: 100 }, 800, 600).zoom).toBe(1);
    const big = fitCamera({ x: 0, y: 0, w: 4000, h: 1000 }, 848, 600);
    expect(big.zoom).toBeCloseTo(0.188, 3);
    // The board's middle is the viewport's middle.
    const mid = center(big, 848, 600);
    expect(mid.x).toBeCloseTo(2000, 6);
    expect(mid.y).toBeCloseTo(500, 6);
    // A board too big for 10% is shown at 10%.
    expect(fitCamera({ x: 0, y: 0, w: 2_000_000, h: 10 }, 800, 600).zoom).toBe(MIN_ZOOM);
    expect(fitCamera(null, 800, 600)).toEqual({ x: -48, y: -48, zoom: 1 });
    expect(fitCamera({ x: 0, y: 0, w: 100, h: 100 }, 0, 600)).toEqual({ x: -48, y: -48, zoom: 1 });
  });

  it("keeps the camera per viewer, and ignores what is not a camera", () => {
    const { store, win } = storageWindow();
    expect(loadCamera(win)).toBeNull();
    saveCamera(win, { x: 1, y: 2, zoom: 3 });
    expect(loadCamera(win)).toEqual({ x: 1, y: 2, zoom: 3 });
    // A stored zoom out of range comes back clamped.
    store.set(KEY, '{"x":0,"y":0,"zoom":50}');
    expect(loadCamera(win)).toEqual({ x: 0, y: 0, zoom: MAX_ZOOM });
    for (const raw of [
      '{"x":"1","y":0,"zoom":1}',
      '{"x":3000000,"y":0,"zoom":1}',
      '{"x":0,"y":0}',
      "null",
      "[1,2,3]",
      "{not json",
    ]) {
      store.set(KEY, raw);
      expect(loadCamera(win), raw).toBeNull();
    }
  });

  it("survives storage that throws, on read and on write", () => {
    const broken = {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    } as unknown as Window;
    expect(loadCamera(broken)).toBeNull();
    expect(() => saveCamera(broken, { x: 0, y: 0, zoom: 1 })).not.toThrow();
    const full = {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      },
    } as unknown as Window;
    expect(loadCamera(full)).toBeNull();
    expect(() => saveCamera(full, { x: 0, y: 0, zoom: 1 })).not.toThrow();
  });
});
