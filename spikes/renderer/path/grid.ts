// Ported from habblaud client/src/world/path/grid.ts (MIT, © 2026 Márcio Junior)
// P0-06 spike copy. The real port, with its tests, is P2-03.
// Walkability grid for the building (1 cell per tile).
//   0 = blocked, 1 = free, 2 = free but avoided (seats: A* only goes through when it must).

export const BLOCKED = 0;
export const FREE = 1;
export const SEAT = 2;

export class WalkGrid {
  readonly cells: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
    readonly version = 0,
  ) {
    this.cells = new Uint8Array(w * h);
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  get(x: number, y: number): number {
    return this.inside(x, y) ? this.cells[y * this.w + x]! : BLOCKED;
  }

  set(x: number, y: number, v: number): void {
    if (this.inside(x, y)) this.cells[y * this.w + x] = v;
  }

  walkable(x: number, y: number): boolean {
    return this.get(x, y) !== BLOCKED;
  }

  fill(x: number, y: number, w: number, h: number, v: number): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, v);
  }
}
