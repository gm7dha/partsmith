/**
 * Sheet metal: a part made of flat walls of one thickness joined by bends,
 * like Onshape's sheet metal. The part is kept as this small model — a base
 * wall from a sketch, and flanges bent up (or down) off the walls' straight
 * edges — so the folded part and its flat pattern (for laser cutting) always
 * come from the same thing.
 *
 * Each wall is a flat outline in its own frame: it covers its outline in
 * (u, v) and runs from 0 to the thickness along n. Outlines go round
 * anticlockwise, so each edge's outside is on its right. Flange walls are
 * rectangles: edge 0 is where they bend off their parent, 1 and 3 their sides,
 * 2 their tip.
 *
 * A flange's length is measured on the outside, from the face it bends away
 * from to its tip (for a right-angle flange: how tall it stands). The flat
 * pattern adds each bend's allowance, angle × (radius + K-factor × thickness).
 */
import type { Segment } from "../sketch/regions";

export type V3 = [number, number, number];
export type P2 = [number, number];

export interface Frame3 {
  origin: V3;
  u: V3;
  v: V3;
  n: V3;
}

/** Where a wall lies in the flat pattern: local (x, y) → origin + x·u + y·v. */
export interface Flat2 {
  origin: P2;
  u: P2;
  v: P2;
}

export interface FlangeSpec {
  id: string;
  /** The wall it bends off, and which of that wall's edges. */
  wall: string;
  edge: number;
  /** Outside length, from the face it bends away from to its tip (mm). */
  length: number;
  /** Bend angle in degrees (90 = straight up), more than 0 and less than 180. */
  angle: number;
  /** Bend the other way (down instead of up). */
  down: boolean;
  /** The flat part's length straight after the bend, instead of working it out from `length` (sheets from an open outline). */
  straight?: number;
  /** Shorten the flange this much at each end of the edge (a bend relief is cut at each end so it can bend). */
  inset?: number;
  /** Its own inside bend radius (hems fold back with a tiny one), instead of the sheet's. */
  radius?: number;
  /** A hem: the edge folded right back on itself (angle 180, `straight` the length of the folded-over part). */
  hem?: boolean;
  /**
   * Close the corner where this flange meets another on the next edge round
   * (both full-length, at 90°, on a square corner): the walls are extended so
   * one laps over the other's end instead of leaving a gap.
   */
  closeCorners?: boolean;
  /** The shape of the bend relief notches cut when the flange is shortened (missing = rectangle). */
  reliefShape?: ReliefShape;
  /** Where this flange meets another at a corner of their wall (and the corner isn't closed): a relief cut there. */
  cornerRelief?: "round" | "square";
  /**
   * Where the flange goes (missing: it bends off the edge, so the sheet gets
   * bigger). "outside": the wall is cut back so the flange's outside face (at
   * 90°; in general the outside faces' sharp corner) lines up with the edge —
   * the sheet keeps its size. "inside": the same for the flange's inside face.
   */
  position?: "outside" | "inside";
  /**
   * A bend along a line across the wall (Bend, Jog) instead of off one of its
   * edges: the line in the wall's coordinates (`edge` isn't used). The wall
   * is cut in two along it; the piece on the line's right (going from `from`
   * to `to`) is bent up (or down) by `angle`, and the piece on its left stays
   * still. The line is the middle of the bend in the flat pattern, so the
   * flat pattern keeps the wall's shape.
   */
  line?: { from: P2; to: P2 };
  /**
   * Mitre the corners where this flange (or hem) meets another on the next
   * edge round: both are trimmed square to the sheet along the line halfway
   * between the two edges, `mitre` mm apart (0 = touching), instead of
   * running into each other.
   */
  mitre?: number;
}

/** Bend relief notches: square-ended, round-ended (obround), or a thin tear. */
export type ReliefShape = "rectangle" | "round" | "tear";

/** A relief cut where two bends meet at a corner of a wall (in the wall's coordinates): a circle or square of half-size `r` on the corner. */
export interface CornerRelief {
  wall: string;
  at: P2;
  /** The two edges' directions away from the corner (along the first, then the second). */
  e1: P2;
  e2: P2;
  r: number;
  shape: "round" | "square";
  /** The two flanges meeting there. */
  flanges: [string, string];
  /** How far it reaches below the wall's bottom and above its top (the bends' radius). */
  below: number;
  above: number;
}

/** A corner relief's outline in its wall's coordinates (a circle as many points, or the square). */
export function cornerReliefPoints(c: CornerRelief, steps = 32): P2[] {
  const at = (s: number, t: number): P2 => [c.at[0] + c.e1[0] * s + c.e2[0] * t, c.at[1] + c.e1[1] * s + c.e2[1] * t];
  if (c.shape === "square") return [at(-c.r, -c.r), at(c.r, -c.r), at(c.r, c.r), at(-c.r, c.r)];
  return Array.from({ length: steps }, (_, i) => {
    const a = (2 * Math.PI * i) / steps;
    return at(c.r * Math.cos(a), c.r * Math.sin(a));
  });
}

export interface TabSpec {
  id: string;
  wall: string;
  /** In the wall's own coordinates. */
  outline: Segment[];
  holes: Segment[][];
}

/** Corner break: a wall's outside corner rounded off (a radius) or cut off straight (a chamfer, `size` back along each edge). */
export interface CornerBreak {
  id: string;
  wall: string;
  /** The corner, in the wall's coordinates. */
  at: P2;
  kind: "round" | "chamfer";
  size: number;
}

export interface SheetSpec {
  thickness: number;
  /** Inside bend radius. */
  radius: number;
  /** Where the material neither stretches nor squashes in a bend, as a fraction of the thickness from the inside (0.45 is usual). */
  k: number;
  base: { frame: Frame3; outer: Segment[]; holes: Segment[][] };
  flanges: FlangeSpec[];
  /** Tabs: flat shapes sketched on a wall's face, joined onto that wall. */
  tabs?: TabSpec[];
  /** Corners of walls rounded or cut off. */
  corners?: CornerBreak[];
}

export interface Wall {
  id: string;
  frame: Frame3;
  outline: Segment[];
  holes: Segment[][];
  flat: Flat2;
  /** Flange walls: edge 0 is the bend. */
  bendEdge?: number;
  /** Tabs: extra flat shapes joined onto the wall (in its coordinates). */
  tabs?: { outline: Segment[]; holes: Segment[][] }[];
}

export interface Bend {
  flangeId: string;
  parent: string;
  /** The parent's edge it bends off. */
  edge: number;
  child: string;
  /** How much shorter than its edge it is at each end, and the relief notches cut into the parent there (in the parent's coordinates, start end first). */
  inset: number;
  reliefs: Segment[][];
  /** The bend's inside radius, angle (degrees), which way, and the flat wall's height after it. */
  radius: number;
  angle: number;
  down: boolean;
  straight: number;
  /** The bend's cross-section, drawn in the plane through `start` with x along `out` and y along `up`, swept along `along` for `length`. */
  start: V3;
  out: V3;
  up: V3;
  along: V3;
  length: number;
  profile: Segment[];
  /** A bend along a line (Bend, Jog): where the moving piece's frame goes — its wall's frame turned and moved with it. */
  moved?: Frame3;
  /** Flat pattern: the line down the middle of the bend, and the strip's width (the bend allowance). */
  flatLine: [P2, P2];
  allowance: number;
  /**
   * Where the bend's strip lies in the flat pattern: a point `x` along the bend
   * (from `start`, along `along`) and `s` across it (unrolled, from the parent's
   * side, 0 to `allowance`) is at origin + x·u + s·v.
   */
  flat: Flat2;
}

export interface FoldedSheet {
  walls: Wall[];
  bends: Bend[];
  /** Strips cut off walls so flanges sit flush with their edges (`position`), in the walls' coordinates. */
  trims?: { flangeId: string; wall: string; outline: Segment[] }[];
  /** Relief cuts where bends meet at a wall's corners. */
  cornerReliefs?: CornerRelief[];
  /** Mitred corners: the two flanges (or hems) whose walls were trimmed where they meet. */
  mitres?: { flanges: [string, string]; walls: [string, string] }[];
  /** Flange id → why it couldn't be made. */
  errors: Record<string, string>;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add2 = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a: P2, s: number): P2 => [a[0] * s, a[1] * s];

/** A wall's local point in 3D (on its 0 side, or `h` along n). */
export function wallPoint(f: Frame3, p: P2, h = 0): V3 {
  return add(add(add(f.origin, mul(f.u, p[0])), mul(f.v, p[1])), mul(f.n, h));
}

/** A wall's local point in the flat pattern. */
export function flatPoint(f: Flat2, p: P2): P2 {
  return add2(add2(f.origin, mul2(f.u, p[0])), mul2(f.v, p[1]));
}


/** The outline as points (curves sampled), anticlockwise. */
export function outlinePoints(segments: Segment[], steps = 12): P2[] {
  // The start of each piece, then points along it (not its end, which is the next piece's start).
  const out: P2[] = [];
  for (const s of segments) {
    switch (s.kind) {
      case "line":
        out.push(s.from);
        break;
      case "arc": {
        const c = circleCentre(s.from, s.mid, s.to);
        if (!c) {
          out.push(s.from);
          break;
        }
        const r = Math.hypot(s.from[0] - c[0], s.from[1] - c[1]);
        const a0 = Math.atan2(s.from[1] - c[1], s.from[0] - c[0]);
        const am = Math.atan2(s.mid[1] - c[1], s.mid[0] - c[0]);
        const a1 = Math.atan2(s.to[1] - c[1], s.to[0] - c[0]);
        // Which way round passes through the middle point.
        const ccw = ((am - a0 + 4 * Math.PI) % (2 * Math.PI)) < ((a1 - a0 + 4 * Math.PI) % (2 * Math.PI));
        let sweep = ccw ? (a1 - a0 + 4 * Math.PI) % (2 * Math.PI) : -((a0 - a1 + 4 * Math.PI) % (2 * Math.PI));
        if (Math.abs(sweep) < 1e-12) sweep = ccw ? 2 * Math.PI : -2 * Math.PI;
        for (let k = 0; k < steps; k++) out.push([c[0] + r * Math.cos(a0 + (sweep * k) / steps), c[1] + r * Math.sin(a0 + (sweep * k) / steps)]);
        break;
      }
      case "bezier":
        for (let k = 0; k < steps; k++) {
          const t = k / steps;
          const u = 1 - t;
          const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
          out.push([
            w[0] * s.from[0] + w[1] * s.c1[0] + w[2] * s.c2[0] + w[3] * s.to[0],
            w[0] * s.from[1] + w[1] * s.c1[1] + w[2] * s.c2[1] + w[3] * s.to[1],
          ]);
        }
        break;
      case "circle":
        for (let k = 0; k < steps * 4; k++) out.push([s.center[0] + s.radius * Math.cos((2 * Math.PI * k) / (steps * 4)), s.center[1] + s.radius * Math.sin((2 * Math.PI * k) / (steps * 4))]);
        break;
      case "ellipse":
        for (let k = 0; k < steps * 4; k++) {
          const t = (2 * Math.PI * k) / (steps * 4);
          const x = s.rx * Math.cos(t);
          const y = s.ry * Math.sin(t);
          out.push([s.center[0] + x * Math.cos(s.angle) - y * Math.sin(s.angle), s.center[1] + x * Math.sin(s.angle) + y * Math.cos(s.angle)]);
        }
        break;
      case "ellipseArc": {
        // From its `from` end to its `to` end, whichever way round that is.
        const at = (t: number): P2 => {
          const x = s.rx * Math.cos(t);
          const y = s.ry * Math.sin(t);
          return [s.center[0] + x * Math.cos(s.angle) - y * Math.sin(s.angle), s.center[1] + x * Math.sin(s.angle) + y * Math.cos(s.angle)];
        };
        const p0 = at(s.t0);
        const forward = Math.hypot(p0[0] - s.from[0], p0[1] - s.from[1]) <= Math.hypot(p0[0] - s.to[0], p0[1] - s.to[1]);
        for (let k = 0; k < steps; k++) out.push(at(forward ? s.t0 + ((s.t1 - s.t0) * k) / steps : s.t1 - ((s.t1 - s.t0) * k) / steps));
        break;
      }
    }
  }
  return out;
}

function circleCentre(a: P2, b: P2, c: P2): P2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1];
  const b2 = b[0] * b[0] + b[1] * b[1];
  const c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

function signedArea(pts: P2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** The same outline the other way round. */
export function reverseSegments(segments: Segment[]): Segment[] {
  return [...segments].reverse().map((s): Segment => {
    switch (s.kind) {
      case "line":
        return { kind: "line", from: s.to, to: s.from };
      case "arc":
        return { kind: "arc", from: s.to, mid: s.mid, to: s.from };
      case "bezier":
        return { kind: "bezier", from: s.to, c1: s.c2, c2: s.c1, to: s.from };
      case "ellipseArc":
        return { ...s, from: s.to, to: s.from };
      default:
        return s;
    }
  });
}

/** An outline turned to go anticlockwise (holes: clockwise). */
export function anticlockwise(segments: Segment[], wantCcw = true): Segment[] {
  const ccw = signedArea(outlinePoints(segments)) > 0;
  return ccw === wantCcw ? segments : reverseSegments(segments);
}

const rect = (w: number, h: number): Segment[] => [
  { kind: "line", from: [0, 0], to: [w, 0] },
  { kind: "line", from: [w, 0], to: [w, h] },
  { kind: "line", from: [w, h], to: [0, h] },
  { kind: "line", from: [0, h], to: [0, 0] },
];

/** Fold the sheet: every wall where it ends up, and the bends between them. */
export function foldSheet(spec: SheetSpec): FoldedSheet {
  const T = spec.thickness;
  const base: Wall = {
    id: "base",
    frame: spec.base.frame,
    outline: anticlockwise(spec.base.outer),
    holes: spec.base.holes.map((h) => anticlockwise(h, false)),
    flat: { origin: [0, 0], u: [1, 0], v: [0, 1] },
  };
  const walls: Wall[] = [base];
  const bends: Bend[] = [];
  const errors: Record<string, string> = {};
  const used = new Set<string>();
  const trims: NonNullable<FoldedSheet["trims"]> = [];
  setBack(spec, base, errors, trims);
  const mitres: NonNullable<FoldedSheet["mitres"]> = [];
  const anyMitre = spec.flanges.some((f) => f.mitre !== undefined);

  spec.flanges.forEach((fl, index) => {
    if (errors[fl.id]) return;
    if (fl.line) {
      lineBend(spec, fl, index, walls, bends, errors, trims, used);
      return;
    }
    const parent = walls.find((w) => w.id === fl.wall);
    const seg = parent?.outline[fl.edge];
    if (!parent || !seg) {
      errors[fl.id] = "The edge it bends off can't be found any more. Edit this flange and pick the edge again.";
      return;
    }
    if (seg.kind !== "line") {
      errors[fl.id] = "Flanges bend off straight edges. Pick a straight edge.";
      return;
    }
    if (parent.bendEdge === fl.edge) {
      errors[fl.id] = "That edge is already bent (it's where this wall joins the one before).";
      return;
    }
    if (cornerBroken(spec, fl.wall, seg)) {
      errors[fl.id] = CORNER_BROKEN;
      return;
    }
    const key = `${fl.wall}:${fl.edge}`;
    if (used.has(key)) {
      errors[fl.id] = "That edge already has a flange.";
      return;
    }
    if (!(fl.angle > 0 && (fl.angle < 180 || (fl.hem && fl.angle <= 180)))) {
      errors[fl.id] = "The bend angle must be more than 0° and less than 180°.";
      return;
    }
    const R = fl.radius ?? spec.radius;
    const theta = (fl.angle * Math.PI) / 180;
    const straight = fl.straight ?? fl.length - (R + T) * Math.tan(theta / 2);
    if (straight < 0.01) {
      errors[fl.id] =
        fl.straight !== undefined
          ? "A line in the outline is too short for the bends at its ends. Make it longer, or use a smaller bend radius."
          : `Too short for its bend: make it longer than ${Math.ceil(((R + T) * Math.tan(theta / 2) + 0.01) * 100) / 100} mm, or use a smaller bend radius.`;
      return;
    }
    used.add(key);

    const [ax, ay] = seg.from;
    const [bx, by] = seg.to;
    const full = Math.hypot(bx - ax, by - ay);
    const e2: P2 = [(bx - ax) / full, (by - ay) / full];
    const inset = Math.max(0, fl.inset ?? 0);
    const len = full - 2 * inset;
    if (len < 0.01) {
      used.delete(key);
      errors[fl.id] = `Shortened too much: that edge is only ${Math.round(full * 100) / 100} mm long.`;
      return;
    }
    // The flange's ends along the edge, and relief notches (thickness wide and deep) into the parent beyond them.
    const along = (t: number): P2 => [ax + e2[0] * t, ay + e2[1] * t];
    const startP = along(inset);
    const endP = along(full - inset);
    const into: P2 = [-e2[1], e2[0]];
    const shape = fl.reliefShape ?? "rectangle";
    // A tear is just a thin cut; the others are as wide as the sheet is thick (or the shortening, if less).
    const w = shape === "tear" ? Math.min(0.2, T / 4, inset) : Math.min(T, inset);
    const notch = (t0: number): Segment[] => {
      const p = along(t0);
      const q = along(t0 + w);
      const deep = (x: P2, d: number): P2 => [x[0] + into[0] * d, x[1] + into[1] * d];
      if (shape === "round") {
        // Round-ended: straight sides, then a half circle at the bottom, T deep in all.
        const side = T - w / 2;
        const mid = deep(along(t0 + w / 2), T);
        return anticlockwise([
          { kind: "line", from: p, to: q },
          { kind: "line", from: q, to: deep(q, side) },
          { kind: "arc", from: deep(q, side), mid, to: deep(p, side) },
          { kind: "line", from: deep(p, side), to: p },
        ]);
      }
      return anticlockwise([
        { kind: "line", from: p, to: q },
        { kind: "line", from: q, to: deep(q, T) },
        { kind: "line", from: deep(q, T), to: deep(p, T) },
        { kind: "line", from: deep(p, T), to: p },
      ]);
    };
    const reliefs = inset > 1e-9 ? [notch(inset - w), notch(full - inset)] : [];
    const g = bendAt(spec, parent, e2, startP, endP, R, theta, fl.down);
    const child: Wall = {
      id: fl.id,
      frame: g.frame,
      outline: rect(len, straight),
      holes: [],
      flat: g.flat,
      bendEdge: 0,
    };
    walls.push(child);
    setBack(spec, child, errors, trims);
    bends.push({ flangeId: fl.id, parent: parent.id, edge: fl.edge, child: child.id, inset, reliefs, radius: R, angle: fl.angle, down: fl.down, straight, length: len, ...g.bend });
    // Mitred corners with flanges already on the edges either side, trimmed now so flanges made later on these walls
    // go on their trimmed edges.
    if (anyMitre) {
      const k = parent.outline.length;
      mitreCorner(spec, walls, bends, parent, (fl.edge - 1 + k) % k, mitres);
      mitreCorner(spec, walls, bends, parent, fl.edge, mitres);
    }
  });
  closeCorners(spec, walls, bends, new Set(mitres.flatMap((m) => m.walls)));
  const cornerReliefs = findCornerReliefs(spec, walls, bends);
  for (const t of spec.tabs ?? []) {
    const w = walls.find((x) => x.id === t.wall);
    if (!w) {
      errors[t.id] = "The wall this tab was on can't be found any more. Edit the tab's sketch.";
      continue;
    }
    w.tabs = [...(w.tabs ?? []), { outline: anticlockwise(t.outline), holes: t.holes.map((h) => anticlockwise(h, false)) }];
  }
  return { walls, bends, errors, ...(cornerReliefs.length ? { cornerReliefs } : {}), ...(trims.length ? { trims } : {}), ...(mitres.length ? { mitres } : {}) };
}

/**
 * A bend off a wall's straight edge (from `startP` to `endP`, running `e2`, in
 * the wall's coordinates): the new wall's frame and flat place (its edge 0
 * along the bend, from the `endP` end), and the bend's shape and flat strip.
 */
function bendAt(spec: SheetSpec, parent: Wall, e2: P2, startP: P2, endP: P2, R: number, theta: number, down: boolean) {
  const T = spec.thickness;
  const f = parent.frame;
  const e = add(mul(f.u, e2[0]), mul(f.v, e2[1]));
  const n = f.n;
  const o = cross3(e, n); // outward: the right of an anticlockwise edge
  const s0 = wallPoint(f, endP);
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  let origin: V3;
  let d: V3;
  let nn: V3;
  let profile: Segment[];
  const at = (c: P2, r: number, a: number, dn: boolean): P2 => (dn ? [c[0] + r * Math.sin(a), c[1] + r * Math.cos(a)] : [c[0] + r * Math.sin(a), c[1] - r * Math.cos(a)]);
  if (!down) {
    const c: P2 = [0, T + R];
    origin = add(s0, add(mul(o, (R + T) * sin), mul(n, T + R - (R + T) * cos)));
    d = add(mul(o, cos), mul(n, sin));
    nn = add(mul(o, -sin), mul(n, cos));
    profile = [
      { kind: "arc", from: [0, 0], mid: at(c, R + T, theta / 2, false), to: at(c, R + T, theta, false) },
      { kind: "line", from: at(c, R + T, theta, false), to: at(c, R, theta, false) },
      { kind: "arc", from: at(c, R, theta, false), mid: at(c, R, theta / 2, false), to: [0, T] },
      { kind: "line", from: [0, T], to: [0, 0] },
    ];
  } else {
    const c: P2 = [0, -R];
    origin = add(s0, add(mul(o, R * sin), mul(n, -R + R * cos)));
    d = add(mul(o, cos), mul(n, -sin));
    nn = add(mul(o, sin), mul(n, cos));
    profile = [
      { kind: "arc", from: [0, 0], mid: at(c, R, theta / 2, true), to: at(c, R, theta, true) },
      { kind: "line", from: at(c, R, theta, true), to: at(c, R + T, theta, true) },
      { kind: "arc", from: at(c, R + T, theta, true), mid: at(c, R + T, theta / 2, true), to: [0, T] },
      { kind: "line", from: [0, T], to: [0, 0] },
    ];
  }
  const allowance = theta * (R + spec.k * T);
  // Flat: the parent's edge, then the bend's strip outwards, then the new wall.
  const pf = parent.flat;
  const eF: P2 = add2(mul2(pf.u, e2[0]), mul2(pf.v, e2[1]));
  const outF: P2 = [eF[1], -eF[0]];
  const bF = flatPoint(pf, endP);
  const aF = flatPoint(pf, startP);
  return {
    frame: { origin, u: mul(e, -1), v: d, n: nn } as Frame3,
    flat: { origin: add2(bF, mul2(outF, allowance)), u: mul2(eF, -1), v: outF } as Flat2,
    bend: {
      start: s0,
      out: o,
      up: n,
      along: mul(e, -1),
      profile,
      flatLine: [add2(aF, mul2(outF, allowance / 2)), add2(bF, mul2(outF, allowance / 2))] as [P2, P2],
      allowance,
      flat: { origin: bF, u: mul2(eF, -1), v: outF } as Flat2,
    },
  };
}

/** The allowance (flat length) of a bend. */
export function bendAllowance(angle: number, radius: number, thickness: number, k: number): number {
  return ((angle * Math.PI) / 180) * (radius + k * thickness);
}

/**
 * Bend along a line (`fl.line`): the wall cut in two along the line, the
 * piece on its right bent up (or down) off the cut, like a flange whose
 * shape is the rest of the wall. The line is the bend's middle in the flat
 * pattern.
 */
function lineBend(spec: SheetSpec, fl: FlangeSpec, index: number, walls: Wall[], bends: Bend[], errors: Record<string, string>, trims: NonNullable<FoldedSheet["trims"]>, used: Set<string>): void {
  const line = fl.line!;
  const T = spec.thickness;
  const parent = walls.find((w) => w.id === fl.wall);
  if (!parent) {
    errors[fl.id] = "The wall this bend was on can't be found any more. Edit the bend and choose its sketch again.";
    return;
  }
  if (!(fl.angle > 0 && fl.angle < 180)) {
    errors[fl.id] = "The bend angle must be more than 0° and less than 180°.";
    return;
  }
  const L = Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1]);
  if (L < 1e-9) {
    errors[fl.id] = "The bend line has no length. Draw a line across the face.";
    return;
  }
  const R = fl.radius ?? spec.radius;
  const theta = (fl.angle * Math.PI) / 180;
  const allowance = theta * (R + spec.k * T);
  const dir: P2 = [(line.to[0] - line.from[0]) / L, (line.to[1] - line.from[1]) / L];
  const split = splitWall(parent.outline, parent.holes, line.from, dir, allowance / 2, parent.bendEdge !== undefined);
  if (typeof split === "string") {
    errors[fl.id] = split;
    return;
  }
  // Flanges and bends already on this wall must be on edges of the piece that stays still; they're renumbered.
  const already = bends.filter((b) => b.parent === parent.id);
  for (const b of already) {
    if (split.crossed.includes(b.edge)) {
      errors[fl.id] = "The bend line crosses an edge that already has a flange or bend on it. Move the line so it crosses plain edges, or make this bend first (drag it above that flange in the feature list).";
      return;
    }
    if (!split.fixedFrom.includes(b.edge)) {
      errors[fl.id] = "There's a flange or bend on the side that would move. Tick “Keep the other side still” to bend the other side, or make this bend first (drag it above that flange in the feature list).";
      return;
    }
  }
  for (const b of already) used.delete(`${parent.id}:${b.edge}`);
  for (const b of already) {
    b.edge = split.fixedFrom.indexOf(b.edge);
    used.add(`${parent.id}:${b.edge}`);
  }
  parent.outline = split.fixed;
  parent.holes = split.fixedHoles;
  const seg = split.fixed[split.fixedEdge] as Extract<Segment, { kind: "line" }>;
  used.add(`${parent.id}:${split.fixedEdge}`);
  const full = Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]);
  const e2: P2 = [(seg.to[0] - seg.from[0]) / full, (seg.to[1] - seg.from[1]) / full];
  const out: P2 = [e2[1], -e2[0]];
  const g = bendAt(spec, parent, e2, seg.from, seg.to, R, theta, fl.down);
  // The moving piece in the new wall's coordinates: x back along the cut from its end, y on from the bend.
  const toChild = (p: P2): P2 => {
    const q: P2 = [p[0] - seg.to[0], p[1] - seg.to[1]];
    return [-(q[0] * e2[0] + q[1] * e2[1]), q[0] * out[0] + q[1] * out[1] - allowance];
  };
  const outline = mapSegments(split.moving, toChild);
  const child: Wall = { id: fl.id, frame: g.frame, outline, holes: split.movingHoles.map((h) => mapSegments(h, toChild)), flat: g.flat, bendEdge: 0 };
  walls.push(child);
  // Where the wall's own frame goes for the piece that moves (for moving material already cut in it).
  const c0 = toChild([0, 0]);
  const cu = toChild([1, 0]);
  const cv = toChild([0, 1]);
  const lin = (c: P2): V3 => add(mul(child.frame.u, c[0] - c0[0]), mul(child.frame.v, c[1] - c0[1]));
  const moved: Frame3 = { origin: wallPoint(child.frame, c0), u: lin(cu), v: lin(cv), n: child.frame.n };
  const straight = Math.max(...outlinePoints(outline).map((p) => p[1]));
  bends.push({ flangeId: fl.id, parent: parent.id, edge: split.fixedEdge, child: fl.id, inset: 0, reliefs: [], radius: R, angle: fl.angle, down: fl.down, straight, length: full, moved, ...g.bend });
  // Flanges flush with an edge, made after this bend.
  setBack(spec, parent, errors, trims, index + 1);
  setBack(spec, child, errors, trims, index + 1);
}

/**
 * A wall's outline (and holes) cut in two by a bend along a line (through
 * `p0`, running `dir`): the bend takes a strip `h` either side of the line;
 * the piece on the line's left stays (`fixed`, the cut its edge
 * `fixedEdge`), the piece on its right (`moving`, the cut its edge 0, from
 * the end of the fixed piece's cut) bends. The bend must cross two straight
 * edges square, away from corners, curves and holes. With `keepFirst`, the
 * wall's edge 0 (where it joins the wall before) must stay, and stays first.
 */
export function splitWall(outline: Segment[], holes: Segment[][], p0: P2, dir: P2, h: number, keepFirst = false):
  | { fixed: Segment[]; fixedEdge: number; moving: Segment[]; fixedHoles: Segment[][]; movingHoles: Segment[][]; fixedFrom: number[]; crossed: [number, number] }
  | string {
  const right: P2 = [dir[1], -dir[0]];
  const dist = (p: P2) => (p[0] - p0[0]) * right[0] + (p[1] - p0[1]) * right[1];
  const eps = 1e-7;
  const pointsOf = (seg: Segment) => [...outlinePoints([seg]), ...(seg.kind === "line" || seg.kind === "arc" || seg.kind === "bezier" ? [seg.to] : [])];
  type Line = Extract<Segment, { kind: "line" }>;
  const crossings: { i: number; up: boolean }[] = [];
  const side: ("fixed" | "moving" | "cross")[] = [];
  for (let i = 0; i < outline.length; i++) {
    const seg = outline[i];
    const ds = pointsOf(seg).map(dist);
    const lo = Math.min(...ds);
    const hi = Math.max(...ds);
    if (hi <= -h + eps) side.push("fixed");
    else if (lo >= h - eps) side.push("moving");
    else if (seg.kind === "line" && ((dist(seg.from) <= -h + eps && dist(seg.to) >= h - eps) || (dist(seg.from) >= h - eps && dist(seg.to) <= -h + eps))) {
      const L = Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]);
      const along = ((seg.to[0] - seg.from[0]) * dir[0] + (seg.to[1] - seg.from[1]) * dir[1]) / L;
      if (Math.abs(along) > 1e-6) return "The bend line must cross the sheet's edges square (at right angles to them). Draw it at right angles to the edges it crosses.";
      side.push("cross");
      crossings.push({ i, up: dist(seg.to) > dist(seg.from) });
    } else return `The bend (${round2(2 * h)} mm wide in the flat) runs into a corner or a curved edge. Move the line so the bend only crosses two straight edges.`;
  }
  if (crossings.length === 0) return "The bend line doesn't cross this wall. Draw the line right across the face (it's carried on past its ends).";
  if (crossings.length !== 2 || crossings[0].up === crossings[1].up) return "The bend line crosses the wall's edge more than twice. It must cut the wall into just two pieces.";
  const c1 = crossings.find((c) => c.up)!.i; // into the moving side
  const c2 = crossings.find((c) => !c.up)!.i; // back out of it
  const at = (seg: Line, d: number): P2 => {
    const a = dist(seg.from);
    const b = dist(seg.to);
    const t = (d - a) / (b - a);
    return [seg.from[0] + (seg.to[0] - seg.from[0]) * t, seg.from[1] + (seg.to[1] - seg.from[1]) * t];
  };
  const k = outline.length;
  const s1 = outline[c1] as Line;
  const s2 = outline[c2] as Line;
  // The fixed piece: from where c2 leaves the bend, round to where c1 enters it, then across.
  const fixed: { seg: Segment; orig: number }[] = [{ seg: { kind: "line", from: at(s2, -h), to: s2.to }, orig: c2 }];
  for (let j = (c2 + 1) % k; j !== c1; j = (j + 1) % k) fixed.push({ seg: outline[j], orig: j });
  fixed.push({ seg: { kind: "line", from: s1.from, to: at(s1, -h) }, orig: c1 });
  fixed.push({ seg: { kind: "line", from: at(s1, -h), to: at(s2, -h) }, orig: Infinity });
  // The moving piece: the cut first (from c2's side to c1's), then round.
  const moving: Segment[] = [{ kind: "line", from: at(s2, h), to: at(s1, h) }, { kind: "line", from: at(s1, h), to: s1.to }];
  for (let j = (c1 + 1) % k; j !== c2; j = (j + 1) % k) moving.push(outline[j]);
  moving.push({ kind: "line", from: s2.from, to: at(s2, h) });
  if (keepFirst && (side[0] !== "fixed" || !fixed.some((f) => f.orig === 0)))
    return "That side of the wall is joined to the rest of the sheet, so it has to stay still. Change which side stays still.";
  // Keep the wall's edges in their order, starting with the first one still there.
  const first = fixed.reduce((best, f, i) => (f.orig < fixed[best].orig ? i : best), 0);
  const ordered = [...fixed.slice(first), ...fixed.slice(0, first)];
  const fixedHoles: Segment[][] = [];
  const movingHoles: Segment[][] = [];
  for (const hole of holes) {
    const ds = hole.flatMap(pointsOf).map(dist);
    if (Math.max(...ds) <= -h + 1e-6) fixedHoles.push(hole);
    else if (Math.min(...ds) >= h - 1e-6) movingHoles.push(hole);
    else return "A hole in the sheet crosses the bend. Move the line (or the hole) so the bend misses it.";
  }
  return {
    fixed: ordered.map((f) => f.seg),
    fixedEdge: ordered.findIndex((f) => f.orig === Infinity),
    moving,
    fixedHoles,
    movingHoles,
    // Which of the wall's edges each fixed edge was, if it's still whole (-1: shortened by the bend, or the cut).
    fixedFrom: ordered.map((f) => (f.orig === c1 || f.orig === c2 || f.orig === Infinity ? -1 : f.orig)),
    crossed: [c1, c2],
  };
}

/**
 * Jog: where the second bend's line goes (how far past the first line, in
 * the bent-up piece's coordinates) for the step to rise `height` — from a
 * face of the sheet to the same face of the stepped piece — with two bends
 * of `angle` (degrees), or why it can't.
 */
export function jogSpacing(height: number, angle: number, radius: number, thickness: number, k: number): number | string {
  const theta = (angle * Math.PI) / 180;
  if (!(angle > 0 && angle < 180)) return "The bend angle must be more than 0° and less than 180°.";
  const a = bendAllowance(angle, radius, thickness, k);
  // Two bends of radius R (the second the other way) rise T + 2R − (2R + T)·cos θ, plus the straight between them × sin θ.
  const rise = thickness + 2 * radius - (2 * radius + thickness) * Math.cos(theta);
  const straight = (height - rise) / Math.sin(theta);
  if (straight < 0.01) {
    const least = rise + 0.01 * Math.sin(theta);
    return `Too small a step for its two bends: make the height more than ${Math.ceil(least * 100) / 100} mm, or use a smaller bend radius.`;
  }
  return straight + a / 2;
}

const CORNER_BROKEN = "A corner of that edge has been rounded or cut off (Corner break), so it can't take a flange now. Move the flange above the corner break in the list.";

/** Whether a corner at either end of a wall's edge has been rounded or cut off. */
function cornerBroken(spec: SheetSpec, wall: string, seg: { from: P2; to: P2 }): boolean {
  const near = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
  return (spec.corners ?? []).some((c) => c.wall === wall && (near(c.at, seg.from) || near(c.at, seg.to)));
}

/** Where two lines (a point and a direction each) cross, or null if they're parallel. */
function crossing(p: P2, d: P2, q: P2, e: P2): P2 | null {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

/**
 * A new wall's edges cut back for flanges that sit flush with them
 * (`position`), before any flange is bent off it: each such edge moves in by
 * the bend's setback, its neighbours shortened (or lengthened) to meet it.
 * The strips cut off are listed in `trims`.
 */
function setBack(spec: SheetSpec, wall: Wall, errors: Record<string, string>, trims: NonNullable<FoldedSheet["trims"]>, from = 0): void {
  const T = spec.thickness;
  for (const fl of spec.flanges.slice(from)) {
    // A bend along a line across this wall changes its edges: flanges after it are cut back once it's made.
    if (fl.line && fl.wall === wall.id) break;
    if (fl.wall !== wall.id || !fl.position || fl.hem || errors[fl.id]) continue;
    const k = wall.outline.length;
    const seg = wall.outline[fl.edge];
    if (!seg || seg.kind !== "line" || fl.edge === wall.bendEdge) continue; // the main loop explains these
    if (cornerBroken(spec, wall.id, seg)) {
      errors[fl.id] = CORNER_BROKEN;
      continue;
    }
    if (!(fl.angle > 0 && fl.angle < 180)) continue;
    const R = fl.radius ?? spec.radius;
    const dist = (fl.position === "outside" ? R + T : R) * Math.tan((fl.angle * Math.PI) / 360);
    if (dist < 1e-9) continue;
    const prevAt = (fl.edge - 1 + k) % k;
    const nextAt = (fl.edge + 1) % k;
    const prev = wall.outline[prevAt];
    const next = wall.outline[nextAt];
    if (prevAt === wall.bendEdge || nextAt === wall.bendEdge) {
      errors[fl.id] = "A flange on the side of another flange can only bend off the edge (it can't sit flush there). Set the position to “Bend off the edge”.";
      continue;
    }
    if (prev.kind !== "line" || next.kind !== "line") {
      errors[fl.id] = "To sit flush with the edge, the edges either side of it must be straight. Set the position to “Bend off the edge”, or make those edges straight.";
      continue;
    }
    const L = Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]);
    const e: P2 = [(seg.to[0] - seg.from[0]) / L, (seg.to[1] - seg.from[1]) / L];
    const into: P2 = [-e[1], e[0]];
    const from: P2 = [seg.from[0] + into[0] * dist, seg.from[1] + into[1] * dist];
    const a = crossing(prev.from, [prev.to[0] - prev.from[0], prev.to[1] - prev.from[1]], from, e);
    const b = crossing(next.from, [next.to[0] - next.from[0], next.to[1] - next.from[1]], from, e);
    const along = (p: P2) => (p[0] - from[0]) * e[0] + (p[1] - from[1]) * e[1];
    const ok = (p: P2, q: P2) => (p[0] - q[0]) * into[0] + (p[1] - q[1]) * into[1] > -1e-9;
    // The edge still runs the same way, and its neighbours still have some length left, running into the wall.
    if (
      !a ||
      !b ||
      along(b) - along(a) < 0.01 ||
      Math.hypot(a[0] - prev.from[0], a[1] - prev.from[1]) < 0.01 ||
      Math.hypot(next.to[0] - b[0], next.to[1] - b[1]) < 0.01 ||
      !ok(prev.from, a) ||
      !ok(next.to, b)
    ) {
      errors[fl.id] = `The wall is too small to cut back ${round2(dist)} mm for this flange to sit flush. Set the position to “Bend off the edge”.`;
      continue;
    }
    trims.push({
      flangeId: fl.id,
      wall: wall.id,
      outline: anticlockwise([
        { kind: "line", from: seg.from, to: seg.to },
        { kind: "line", from: seg.to, to: b },
        { kind: "line", from: b, to: a },
        { kind: "line", from: a, to: seg.from },
      ]),
    });
    const outline = [...wall.outline];
    outline[prevAt] = { kind: "line", from: prev.from, to: a };
    outline[fl.edge] = { kind: "line", from: a, to: b };
    outline[nextAt] = { kind: "line", from: b, to: next.to };
    wall.outline = outline;
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Corner reliefs: where bends off two neighbouring edges of a wall meet at
 * their shared corner (neither shortened there, and the corner not closed),
 * and either flange asks for one, a round or square cut on the corner, the
 * size of the bend (radius plus thickness), so the bends don't tear into
 * each other.
 */
function findCornerReliefs(spec: SheetSpec, walls: Wall[], bends: Bend[]): CornerRelief[] {
  const T = spec.thickness;
  const flange = new Map(spec.flanges.map((f) => [f.id, f]));
  const out: CornerRelief[] = [];
  for (const w of walls) {
    const k = w.outline.length;
    for (let i = 0; i < k; i++) {
      const a = bends.find((b) => b.parent === w.id && b.edge === i);
      const b = bends.find((x) => x.parent === w.id && x.edge === (i + 1) % k);
      if (!a || !b || a.inset > 1e-9 || b.inset > 1e-9) continue;
      const fa = flange.get(a.flangeId);
      const fb = flange.get(b.flangeId);
      if (fa?.closeCorners || fb?.closeCorners) continue;
      const shape = fa?.cornerRelief ?? fb?.cornerRelief;
      if (!shape) continue;
      const sa = w.outline[i];
      const sb = w.outline[(i + 1) % k];
      if (sa.kind !== "line" || sb.kind !== "line") continue;
      const R = Math.max(a.radius, b.radius);
      out.push({
        wall: w.id,
        at: sa.to,
        e1: unit2([sa.from[0] - sa.to[0], sa.from[1] - sa.to[1]]),
        e2: unit2([sb.to[0] - sb.from[0], sb.to[1] - sb.from[1]]),
        r: R + T,
        shape,
        flanges: [a.flangeId, b.flangeId],
        below: a.down || b.down ? R : 0,
        above: a.down && b.down ? 0 : R,
      });
    }
  }
  return out;
}

/** A wall's rectangle from u0 to u1 along its bend edge, `h` high. */
const rectRange = (u0: number, u1: number, h: number): Segment[] => [
  { kind: "line", from: [u0, 0], to: [u1, 0] },
  { kind: "line", from: [u1, 0], to: [u1, h] },
  { kind: "line", from: [u1, h], to: [u0, h] },
  { kind: "line", from: [u0, h], to: [u0, 0] },
];

/**
 * Closed corners: where two full-length right-angle flanges meet at a square
 * corner of their wall and either asks for it, extend their ends so the
 * corner is closed — the first flange's wall runs on to the outside of the
 * second's, and the second's runs on to butt against the first's inside.
 */
function closeCorners(spec: SheetSpec, walls: Wall[], bends: Bend[], mitred: Set<string>): void {
  const T = spec.thickness;
  const wants = new Set(spec.flanges.filter((f) => f.closeCorners).map((f) => f.id));
  if (!wants.size) return;
  const ext = new Map<string, { lo: number; hi: number }>();
  const more = (child: string, lo: number, hi: number) => {
    const e = ext.get(child) ?? { lo: 0, hi: 0 };
    ext.set(child, { lo: Math.max(e.lo, lo), hi: Math.max(e.hi, hi) });
  };
  for (const w of walls) {
    const k = w.outline.length;
    for (let i = 0; i < k; i++) {
      const a = bends.find((b) => b.parent === w.id && b.edge === i);
      const b = bends.find((x) => x.parent === w.id && x.edge === (i + 1) % k);
      if (!a || !b || (!wants.has(a.flangeId) && !wants.has(b.flangeId))) continue;
      const sa = w.outline[i];
      const sb = w.outline[(i + 1) % k];
      if (sa.kind !== "line" || sb.kind !== "line") continue;
      const ea = unit2([sa.to[0] - sa.from[0], sa.to[1] - sa.from[1]]);
      const eb = unit2([sb.to[0] - sb.from[0], sb.to[1] - sb.from[1]]);
      const square = Math.abs(ea[0] * eb[0] + ea[1] * eb[1]) < 1e-6 && ea[0] * eb[1] - ea[1] * eb[0] > 0;
      const right = (x: Bend) => Math.abs(x.angle - 90) < 1e-6 && x.inset < 1e-9;
      if (!square || !right(a) || !right(b) || a.down !== b.down) continue;
      // a's wall runs past the corner to b's outside face; b's runs to a's inside face.
      more(a.child, b.radius + T, 0);
      more(b.child, 0, a.radius);
    }
  }
  for (const [id, e] of ext) {
    if (mitred.has(id)) continue; // already trimmed at its other end
    const wall = walls.find((x) => x.id === id);
    const bend = bends.find((x) => x.child === id);
    if (!wall || !bend) continue;
    wall.outline = rectRange(-e.lo, bend.length + e.hi, bend.straight);
  }
}

/**
 * Mitred corners: where flanges (or hems) bent off two neighbouring edges of
 * a wall meet at an outside corner and either asks for it (`mitre`), each
 * new wall is trimmed square to itself so none of it crosses the plane
 * through the corner halfway between the two edges (square to the wall) —
 * less half the gap — so they meet along that line instead of running into
 * each other. Done as soon as both are bent (so flanges made later on these
 * walls go on their trimmed edges); walls that already have flanges of their
 * own, flanges one up and one down, and closed corners are left as they are.
 */
function mitreCorner(spec: SheetSpec, walls: Wall[], bends: Bend[], w: Wall, i: number, out: NonNullable<FoldedSheet["mitres"]>): void {
  const T = spec.thickness;
  const k = w.outline.length;
  const a = bends.find((b) => b.parent === w.id && b.edge === i);
  const b = bends.find((x) => x.parent === w.id && x.edge === (i + 1) % k);
  if (!a || !b) return;
  const fa = spec.flanges.find((f) => f.id === a.flangeId);
  const fb = spec.flanges.find((f) => f.id === b.flangeId);
  if (!fa || !fb || fa.line || fb.line || (fa.mitre === undefined && fb.mitre === undefined) || fa.closeCorners || fb.closeCorners) return;
  // One up and one down never meet.
  if (a.down !== b.down) return;
  const sa = w.outline[i];
  const sb = w.outline[(i + 1) % k];
  if (sa.kind !== "line" || sb.kind !== "line") return;
  const ea = unit2([sa.to[0] - sa.from[0], sa.to[1] - sa.from[1]]);
  const eb = unit2([sb.to[0] - sb.from[0], sb.to[1] - sb.from[1]]);
  // An outside corner turns left going round.
  if (ea[0] * eb[1] - ea[1] * eb[0] < 1e-9) return;
  const ca = walls.find((x) => x.id === a.child);
  const cb = walls.find((x) => x.id === b.child);
  // A wall with flanges of its own already can't be trimmed under them.
  if (!ca || !cb || bends.some((x) => x.parent === ca.id || x.parent === cb.id)) return;
  const gap = Math.max(fa.mitre ?? 0, fb.mitre ?? 0);
  // The plane through the corner, square to the wall, halfway between the edges; m points to a's side.
  const bis = unit2([-ea[0] + eb[0], -ea[1] + eb[1]]);
  let m2: P2 = [-bis[1], bis[0]];
  const midA: P2 = [(sa.from[0] + sa.to[0]) / 2 - sa.to[0], (sa.from[1] + sa.to[1]) / 2 - sa.to[1]];
  if (m2[0] * midA[0] + m2[1] * midA[1] < 0) m2 = [-m2[0], -m2[1]];
  const m: V3 = add(mul(w.frame.u, m2[0]), mul(w.frame.v, m2[1]));
  const corner = wallPoint(w.frame, sa.to);
  const ta = trimByPlane(ca, T, corner, m, gap / 2);
  const tb = trimByPlane(cb, T, corner, mul(m, -1), gap / 2);
  if (!ta || !tb) return;
  ca.outline = ta;
  cb.outline = tb;
  out.push({ flanges: [a.flangeId, b.flangeId], walls: [ca.id, cb.id] });
}

/**
 * A wall's outline cut back so all of it (through its thickness) is at least
 * `gap` on the `m` side of the plane through `at` — square to the wall, so it
 * can be cut flat. Its edge 0 (along its bend) stays first. Null if it can't
 * be done (not all straight edges, or nothing would be left).
 */
function trimByPlane(wall: Wall, T: number, at: V3, m: V3, gap: number): Segment[] | null {
  if (wall.outline.some((s) => s.kind !== "line")) return null;
  const f = wall.frame;
  const A = dot3(f.u, m);
  const B = dot3(f.v, m);
  const C = dot3(sub3(f.origin, at), m) + Math.min(0, T * dot3(f.n, m)) - gap;
  const g = (p: P2) => A * p[0] + B * p[1] + C;
  const pts = wall.outline.map((s) => (s as Extract<Segment, { kind: "line" }>).from);
  if (pts.every((p) => g(p) >= -1e-9)) return wall.outline;
  const kept: { p: P2; base: boolean }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const gp = g(p);
    const gq = g(q);
    // `base`: the point starts a piece of the wall's edge 0.
    if (gp >= 0) kept.push({ p, base: i === 0 });
    if ((gp >= 0) !== (gq >= 0)) {
      const t = gp / (gp - gq);
      kept.push({ p: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], base: i === 0 && gp < 0 });
    }
  }
  // Points repeated (where the plane passes through a corner) are merged.
  const same = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-9;
  const clean: { p: P2; base: boolean }[] = [];
  for (const x of kept) {
    const last = clean[clean.length - 1];
    if (last && same(last.p, x.p)) last.base ||= x.base;
    else clean.push({ ...x });
  }
  if (clean.length > 1 && same(clean[0].p, clean[clean.length - 1].p)) clean[0].base ||= clean.pop()!.base;
  if (clean.length < 3 || Math.abs(signedArea(clean.map((x) => x.p))) < 1e-6) return null;
  const start = clean.findIndex((x) => x.base);
  if (start < 0) return null;
  const ring = [...clean.slice(start), ...clean.slice(0, start)].map((x) => x.p);
  return ring.map((p, i): Segment => ({ kind: "line", from: p, to: ring[(i + 1) % ring.length] }));
}

const unit2 = (v: P2): P2 => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

/** The flat pattern: one outline to cut round (and the holes in it), and the bend lines. */
export interface FlatBend {
  line: [P2, P2];
  /** Degrees; up = towards the sheet's top (n) side. */
  angle: number;
  radius: number;
  up: boolean;
}

export function flatPattern(folded: FoldedSheet): { outline: P2[]; holes: P2[][]; bendLines: [P2, P2][]; bends: FlatBend[] } {
  const childOn = new Map<string, Wall>();
  const bendOn = new Map<string, Bend>();
  for (const b of folded.bends) {
    childOn.set(`${b.parent}:${b.edge}`, folded.walls.find((w) => w.id === b.child)!);
    bendOn.set(`${b.parent}:${b.edge}`, b);
  }
  /** A relief notch's outline in order along the edge: from where it leaves the edge, round its inside, back to the edge. */
  const notchPoints = (wall: Wall, r: Segment[], e2: P2, from: P2): P2[] => {
    const pts = outlinePoints(r);
    const t = (p: P2) => (p[0] - from[0]) * e2[0] + (p[1] - from[1]) * e2[1];
    const onEdge = (p: P2) => Math.abs((p[0] - from[0]) * e2[1] - (p[1] - from[1]) * e2[0]) < 1e-9;
    const n = pts.length;
    // The two corners on the edge are next to each other round the outline; walk the long way from the nearer one to the further.
    const ends = pts.map((_, i) => i).filter((i) => onEdge(pts[i]));
    if (ends.length < 2) return [];
    const [lo, hi] = [...ends].sort((a, b) => t(pts[a]) - t(pts[b]));
    const step = (lo + 1) % n === hi ? -1 : 1;
    const path: P2[] = [];
    for (let i = lo; ; i = (i + step + n) % n) {
      path.push(pts[i]);
      if (i === hi) break;
    }
    return path.map((p) => flatPoint(wall.flat, p));
  };
  const out: P2[] = [];
  /** Go round a wall's outline (skipping its bend edge, where it joins its parent), detouring round any flange on its edges. */
  const walk = (wall: Wall, skip: number | undefined) => {
    const k = wall.outline.length;
    const start = skip === undefined ? 0 : (skip + 1) % k;
    for (let j = 0; j < k; j++) {
      const i = (start + j) % k;
      if (i === skip) continue;
      const seg = wall.outline[i];
      const child = childOn.get(`${wall.id}:${i}`);
      if (seg.kind === "line" && child) {
        const bend = bendOn.get(`${wall.id}:${i}`)!;
        const L = Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]);
        const e2: P2 = [(seg.to[0] - seg.from[0]) / L, (seg.to[1] - seg.from[1]) / L];
        const at = (t: number): P2 => flatPoint(wall.flat, [seg.from[0] + e2[0] * t, seg.from[1] + e2[1] * t]);
        out.push(flatPoint(wall.flat, seg.from));
        if (bend.reliefs.length) out.push(...notchPoints(wall, bend.reliefs[0], e2, seg.from));
        out.push(at(bend.inset));
        // Across the bend's strip to the wall, round the wall (its bottom edge may run past the bend at either
        // end, for a closed corner), and back across the strip.
        out.push(flatPoint(child.flat, [bend.length, 0]));
        walk(child, 0);
        const bottom = child.outline[0];
        if (bottom.kind === "line") out.push(flatPoint(child.flat, bottom.from));
        out.push(flatPoint(child.flat, [0, 0]));
        out.push(at(L - bend.inset));
        if (bend.reliefs.length) out.push(...notchPoints(wall, bend.reliefs[1], e2, seg.from));
      } else {
        for (const p of outlinePoints([seg])) out.push(flatPoint(wall.flat, p));
      }
    }
  };
  walk(folded.walls[0], undefined);
  const holes = folded.walls.flatMap((w) => w.holes.map((h) => outlinePoints(h).map((p) => flatPoint(w.flat, p))));
  return {
    outline: dedupe(out),
    holes,
    bendLines: folded.bends.map((b) => b.flatLine),
    bends: folded.bends.map((b) => ({ line: b.flatLine, angle: b.angle, radius: b.radius, up: !b.down })),
  };
}

/**
 * Line pieces joined end to end into closed loops (pieces that don't close
 * up are left out). Ends within `tol` count as the same point.
 */
export function chainLoops(pieces: [P2, P2][], tol = 1e-6): P2[][] {
  const left = pieces.filter(([a, b]) => Math.hypot(a[0] - b[0], a[1] - b[1]) > tol);
  const same = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const loops: P2[][] = [];
  while (left.length) {
    const [first] = left.splice(0, 1);
    const loop: P2[] = [first[0], first[1]];
    for (;;) {
      const end = loop[loop.length - 1];
      if (same(end, loop[0])) {
        loop.pop();
        if (loop.length >= 3) loops.push(loop);
        break;
      }
      const i = left.findIndex(([a, b]) => same(a, end) || same(b, end));
      if (i < 0) break;
      const [next] = left.splice(i, 1);
      loop.push(same(next[0], end) ? next[1] : next[0]);
    }
  }
  return loops;
}

function dedupe(pts: P2[]): P2[] {
  const out: P2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1e-9) out.pop();
  return out;
}

/**
 * The wall edge a picked straight edge of the folded part lies along (on
 * either face of the sheet), or null. Edges already bent aren't offered.
 */
export function findSheetEdge(folded: FoldedSheet, thickness: number, a: V3, b: V3, tol = 1e-3): { wall: string; edge: number } | null {
  const bent = new Set(folded.bends.map((x) => `${x.parent}:${x.edge}`));
  const onLine = (p: V3, q0: V3, q1: V3) => {
    const dir = sub3(q1, q0);
    const L = Math.hypot(...dir);
    if (L < 1e-9) return false;
    const t = dot3(sub3(p, q0), dir) / (L * L);
    const foot = add(q0, mul(dir, t));
    return Math.hypot(...sub3(p, foot)) < tol && t > -tol / L && t < 1 + tol / L;
  };
  for (const w of folded.walls) {
    for (let i = 0; i < w.outline.length; i++) {
      const s = w.outline[i];
      if (s.kind !== "line" || i === w.bendEdge || bent.has(`${w.id}:${i}`)) continue;
      for (const h of [0, thickness]) {
        const q0 = wallPoint(w.frame, s.from, h);
        const q1 = wallPoint(w.frame, s.to, h);
        if (onLine(a, q0, q1) && onLine(b, q0, q1)) return { wall: w.id, edge: i };
      }
    }
  }
  return null;
}

/** The turn (axis, and degrees about the origin) taking one frame's directions onto another's. */
export function turnBetween(from: Frame3, to: Frame3): { axis: V3; angle: number } {
  // The rotation taking (u, v, n) to (u', v', n'): R = B · Aᵀ, as an axis and angle.
  const A = [from.u, from.v, from.n];
  const B = [to.u, to.v, to.n];
  const R = [0, 1, 2].map((r) => [0, 1, 2].map((c) => B[0][r] * A[0][c] + B[1][r] * A[1][c] + B[2][r] * A[2][c]));
  const trace = R[0][0] + R[1][1] + R[2][2];
  const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  let axis: V3 = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
  const l = Math.hypot(...axis);
  if (l > 1e-9) axis = mul(axis, 1 / l);
  else if (angle > 1e-9) {
    // A half turn: the axis is the eigenvector for +1.
    const k = [0, 1, 2].reduce((best, i) => (R[i][i] > R[best][best] ? i : best), 0);
    const col: V3 = [R[0][k] + (k === 0 ? 1 : 0), R[1][k] + (k === 1 ? 1 : 0), R[2][k] + (k === 2 ? 1 : 0)];
    axis = mul(col, 1 / (Math.hypot(...col) || 1));
  } else axis = [0, 0, 1];
  return { axis, angle: (angle * 180) / Math.PI };
}

/** How much of an outline lies on each side of a line through `p0` running `dir`: [left, right]. */
export function sideAreas(outline: Segment[], p0: P2, dir: P2): [number, number] {
  const pts = outlinePoints(outline);
  const right: P2 = [dir[1], -dir[0]];
  const d = (p: P2) => (p[0] - p0[0]) * right[0] + (p[1] - p0[1]) * right[1];
  const clip = (sign: number) => {
    const out: P2[] = [];
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const a = sign * d(p);
      const b = sign * d(q);
      if (a >= 0) out.push(p);
      if ((a >= 0) !== (b >= 0)) out.push([p[0] + ((q[0] - p[0]) * a) / (a - b), p[1] + ((q[1] - p[1]) * a) / (a - b)]);
    });
    return out.length >= 3 ? Math.abs(signedArea(out)) : 0;
  };
  return [clip(-1), clip(1)];
}

/**
 * How to lay a wall down flat: the frame it occupies in the unfolded sheet
 * (in the base wall's plane), and the turn (axis and degrees about the
 * wall's origin) that takes the wall's frame onto it. For bends, the flat
 * strip each one unrolls into.
 */
export function unfoldMoves(folded: FoldedSheet): {
  walls: { id: string; from: Frame3; to: Frame3; axis: V3; angle: number }[];
  strips: { frame: Frame3; length: number; width: number }[];
} {
  const base = folded.walls[0].frame;
  const inBase = (p: P2): V3 => add(add(base.origin, mul(base.u, p[0])), mul(base.v, p[1]));
  const dirInBase = (d: P2): V3 => add(mul(base.u, d[0]), mul(base.v, d[1]));
  const walls = folded.walls.map((w) => {
    const to: Frame3 = { origin: inBase(w.flat.origin), u: dirInBase(w.flat.u), v: dirInBase(w.flat.v), n: base.n };
    return { id: w.id, from: w.frame, to, ...turnBetween(w.frame, to) };
  });
  const strips = folded.bends.map((b) => {
    const [a, c] = b.flatLine;
    const along: P2 = [c[0] - a[0], c[1] - a[1]];
    const L = Math.hypot(along[0], along[1]) || 1;
    const e: P2 = [along[0] / L, along[1] / L];
    // The strip is centred on the bend line: from its outer side back towards the parent (a right-handed frame).
    const inward: P2 = [-e[1], e[0]];
    const corner: P2 = [a[0] - (inward[0] * b.allowance) / 2, a[1] - (inward[1] * b.allowance) / 2];
    return { frame: { origin: inBase(corner), u: dirInBase(e), v: dirInBase(inward), n: base.n }, length: L, width: b.allowance };
  });
  return { walls, strips };
}

/**
 * The wall a plane lies on (on either face of the sheet, facing either way),
 * or null. `origin` and `n` are the plane's.
 */
export function wallOnPlane(folded: FoldedSheet, thickness: number, origin: V3, n: V3, tol = 1e-4): Wall | null {
  for (const w of folded.walls) {
    const f = w.frame;
    if (Math.abs(Math.abs(dot3(f.n, n)) - 1) > 1e-6) continue;
    const h = dot3(sub3(origin, f.origin), f.n);
    if (Math.abs(h) < tol || Math.abs(h - thickness) < tol) return w;
  }
  return null;
}

/** Outline pieces moved by `map` (a point-by-point change of coordinates that keeps distances). */
export function mapSegments(segments: Segment[], map: (p: P2) => P2): Segment[] {
  return segments.map((s): Segment => {
    switch (s.kind) {
      case "line":
        return { kind: "line", from: map(s.from), to: map(s.to) };
      case "arc":
        return { kind: "arc", from: map(s.from), mid: map(s.mid), to: map(s.to) };
      case "bezier":
        return { kind: "bezier", from: map(s.from), c1: map(s.c1), c2: map(s.c2), to: map(s.to) };
      case "circle":
        return { kind: "circle", center: map(s.center), radius: s.radius };
      case "ellipse": {
        const c = map(s.center);
        const a = map([s.center[0] + Math.cos(s.angle), s.center[1] + Math.sin(s.angle)]);
        return { kind: "ellipse", center: c, rx: s.rx, ry: s.ry, angle: Math.atan2(a[1] - c[1], a[0] - c[0]) };
      }
      case "ellipseArc": {
        const c = map(s.center);
        const a = map([s.center[0] + Math.cos(s.angle), s.center[1] + Math.sin(s.angle)]);
        const b = map([s.center[0] - Math.sin(s.angle), s.center[1] + Math.cos(s.angle)]);
        // A mirror turns the ellipse the other way round, so its parameters run backwards.
        const mirrored = (a[0] - c[0]) * (b[1] - c[1]) - (a[1] - c[1]) * (b[0] - c[0]) < 0;
        const angle = Math.atan2(a[1] - c[1], a[0] - c[0]);
        return { ...s, center: c, angle, t0: mirrored ? -s.t1 : s.t0, t1: mirrored ? -s.t0 : s.t1, from: map(s.from), to: map(s.to) };
      }
    }
  });
}

/**
 * The corner of a wall a picked edge runs along: an edge straight through the
 * sheet (from one face to the other) at a corner of a wall's outline.
 */
export function findSheetCorner(folded: FoldedSheet, thickness: number, a: V3, b: V3, tol = 1e-3): { wall: string; at: P2 } | null {
  const same = (p: V3, q: V3) => Math.hypot(...sub3(p, q)) < tol;
  for (const w of folded.walls) {
    for (const seg of w.outline) {
      if (seg.kind !== "line") continue;
      const q0 = wallPoint(w.frame, seg.from, 0);
      const q1 = wallPoint(w.frame, seg.from, thickness);
      if ((same(a, q0) && same(b, q1)) || (same(a, q1) && same(b, q0))) return { wall: w.id, at: seg.from };
    }
  }
  return null;
}

/**
 * What a corner break takes off a wall: the piece between its corner and the
 * round (or the straight cut), in the wall's coordinates; or why it can't.
 */
export function cornerBreakCut(folded: FoldedSheet, c: Pick<CornerBreak, "wall" | "at" | "kind" | "size">): Segment[] | string {
  const wall = folded.walls.find((w) => w.id === c.wall);
  if (!wall) return "The wall that corner was on can't be found any more. Edit this and pick the corner again.";
  const k = wall.outline.length;
  const near = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
  const j = wall.outline.findIndex((seg) => seg.kind === "line" && near(seg.from, c.at));
  const prev = wall.outline[(j - 1 + k) % k];
  const next = wall.outline[j];
  if (j < 0 || !prev || prev.kind !== "line" || next.kind !== "line") return "Pick a corner where two straight edges of the sheet meet (the short edge through the sheet there).";
  const bent = new Set(folded.bends.filter((b) => b.parent === wall.id).map((b) => b.edge));
  if (wall.bendEdge !== undefined) bent.add(wall.bendEdge);
  if (bent.has(j) || bent.has((j - 1 + k) % k)) return "That corner is next to a bend, so it can't be rounded or cut off. Pick a corner between two free edges.";
  const l1 = Math.hypot(prev.from[0] - c.at[0], prev.from[1] - c.at[1]);
  const l2 = Math.hypot(next.to[0] - c.at[0], next.to[1] - c.at[1]);
  const e1: P2 = [(prev.from[0] - c.at[0]) / l1, (prev.from[1] - c.at[1]) / l1];
  const e2: P2 = [(next.to[0] - c.at[0]) / l2, (next.to[1] - c.at[1]) / l2];
  // An outside corner turns left going round (anticlockwise); an inside one would need metal added.
  const turn = -e1[0] * e2[1] + e1[1] * e2[0];
  if (turn < 1e-9) return "That's an inside corner (or not a corner at all). Corner break rounds or cuts off outside corners.";
  const alpha = Math.acos(Math.max(-1, Math.min(1, e1[0] * e2[0] + e1[1] * e2[1])));
  const back = c.kind === "round" ? c.size / Math.tan(alpha / 2) : c.size;
  if (back > Math.min(l1, l2) - 1e-6) {
    const most = c.kind === "round" ? Math.min(l1, l2) * Math.tan(alpha / 2) : Math.min(l1, l2);
    return `Too big for that corner: its edges are only ${Math.round(Math.min(l1, l2) * 100) / 100} mm long. Use ${c.kind === "round" ? "a radius" : "a distance"} under ${Math.floor(most * 100) / 100} mm.`;
  }
  const p1: P2 = [c.at[0] + e1[0] * back, c.at[1] + e1[1] * back];
  const p2: P2 = [c.at[0] + e2[0] * back, c.at[1] + e2[1] * back];
  if (c.kind === "chamfer") {
    return anticlockwise([
      { kind: "line", from: c.at, to: p1 },
      { kind: "line", from: p1, to: p2 },
      { kind: "line", from: p2, to: c.at },
    ]);
  }
  const bis = unit2([e1[0] + e2[0], e1[1] + e2[1]]);
  const centre: P2 = [c.at[0] + (bis[0] * c.size) / Math.sin(alpha / 2), c.at[1] + (bis[1] * c.size) / Math.sin(alpha / 2)];
  const mid: P2 = [centre[0] - bis[0] * c.size, centre[1] - bis[1] * c.size];
  return anticlockwise([
    { kind: "line", from: c.at, to: p1 },
    { kind: "arc", from: p1, mid, to: p2 },
    { kind: "line", from: p2, to: c.at },
  ]);
}
