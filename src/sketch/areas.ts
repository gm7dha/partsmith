/**
 * The separate areas a sketch's curves divide the plane into, like Onshape's
 * sketch regions: where curves cross (or one ends on another, a T), they are
 * split, so a line across a rectangle makes two areas and a circle overlapping
 * a rectangle makes three.
 *
 * Extrude, Revolve and Sweep normally use every closed shape (`findRegions`,
 * which nests shapes inside each other as holes). When the user clicks the
 * areas they want instead, the feature stores a point inside each one
 * (`regionsAt`); on rebuild each point finds its area again, so small edits to
 * the sketch keep the choice. Areas picked side by side join into one outline.
 *
 * How it works: every solid curve becomes one or more simple pieces (line, arc,
 * ellipse arc, Bézier); pieces are cut where they meet; the cut pieces make a
 * graph whose faces are traced by turning as far right as possible at each
 * junction (the usual planar-map walk). Loose ends and lone bridges between
 * shapes don't bound anything and are dropped first.
 */
import { bezierAt, splineBeziers } from "./spline";
import { ellipseAt, ellipseFrom, type EllipseGeom } from "./ellipse";
import { splineHandles, splineHandlesIn } from "./ops";
import { ellipseSpan } from "./curves";
import { findRegions, pointInPolygon, type Loop, type Pt, type Region, type RegionResult, type Segment } from "./regions";
import { ORIGIN_ID, type SketchData } from "./types";
import { textContours, textPieceId, textsOf } from "./sketchText";

type Bez = [Pt, Pt, Pt, Pt];

/** One simple piece of a sketch curve, run by u from 0 to 1. */
type Prim =
  | { kind: "line"; a: Pt; b: Pt }
  /** Anticlockwise from angle a0 to a1 (a whole circle: a1 = a0 + 2π, closed). */
  | { kind: "arc"; c: Pt; r: number; a0: number; a1: number; closed: boolean }
  /** An ellipse from its own angle t0 to t1 (a whole one: 0 to 2π, closed); u = (t − t0) / (t1 − t0). */
  | { kind: "ellipse"; g: EllipseGeom; t0: number; t1: number; closed: boolean }
  | { kind: "bez"; p: Bez };

const isClosed = (p: Prim) => (p.kind === "arc" || p.kind === "ellipse") && p.closed;

function at(p: Prim, u: number): Pt {
  switch (p.kind) {
    case "line":
      return [p.a[0] + (p.b[0] - p.a[0]) * u, p.a[1] + (p.b[1] - p.a[1]) * u];
    case "arc": {
      const a = p.a0 + (p.a1 - p.a0) * u;
      return [p.c[0] + p.r * Math.cos(a), p.c[1] + p.r * Math.sin(a)];
    }
    case "ellipse":
      return ellipseAt(p.g, p.t0 + (p.t1 - p.t0) * u);
    case "bez":
      return bezierAt(p.p, u);
  }
}

/** First and second derivatives with respect to u. */
function derivs(p: Prim, u: number): [Pt, Pt] {
  switch (p.kind) {
    case "line":
      return [[p.b[0] - p.a[0], p.b[1] - p.a[1]], [0, 0]];
    case "arc": {
      const s = p.a1 - p.a0;
      const a = p.a0 + s * u;
      return [
        [-p.r * s * Math.sin(a), p.r * s * Math.cos(a)],
        [-p.r * s * s * Math.cos(a), -p.r * s * s * Math.sin(a)],
      ];
    }
    case "ellipse": {
      const k = p.t1 - p.t0;
      const t = p.t0 + k * u;
      const c = Math.cos(p.g.angle), s = Math.sin(p.g.angle);
      const dx = -p.g.rx * Math.sin(t) * k, dy = p.g.ry * Math.cos(t) * k;
      const ddx = -p.g.rx * Math.cos(t) * k * k, ddy = -p.g.ry * Math.sin(t) * k * k;
      return [
        [dx * c - dy * s, dx * s + dy * c],
        [ddx * c - ddy * s, ddx * s + ddy * c],
      ];
    }
    case "bez": {
      const [a, b, c, d] = p.p;
      const v = 1 - u;
      const d1: Pt = [
        3 * v * v * (b[0] - a[0]) + 6 * v * u * (c[0] - b[0]) + 3 * u * u * (d[0] - c[0]),
        3 * v * v * (b[1] - a[1]) + 6 * v * u * (c[1] - b[1]) + 3 * u * u * (d[1] - c[1]),
      ];
      const d2: Pt = [
        6 * v * (c[0] - 2 * b[0] + a[0]) + 6 * u * (d[0] - 2 * c[0] + b[0]),
        6 * v * (c[1] - 2 * b[1] + a[1]) + 6 * u * (d[1] - 2 * c[1] + b[1]),
      ];
      return [d1, d2];
    }
  }
}

/** How many straight pieces to draw a whole primitive with. */
function stepsOf(p: Prim): number {
  switch (p.kind) {
    case "line":
      return 1;
    case "arc":
      return Math.max(4, Math.ceil(Math.abs(p.a1 - p.a0) / (Math.PI / 36)));
    case "ellipse":
      return Math.max(8, Math.ceil((72 * (p.t1 - p.t0)) / (2 * Math.PI)));
    case "bez":
      return 16;
  }
}

/** u wrapped into 0…1 for closed primitives. */
const wrap = (p: Prim, u: number) => (isClosed(p) ? u - Math.floor(u) : u);

/** The exact piece of a primitive from u0 to u1 (u1 > u0; may pass 1 on a closed one), as a sketch segment. */
function pieceSegment(p: Prim, u0: number, u1: number, from: Pt, to: Pt): Segment[] {
  switch (p.kind) {
    case "line":
      return [{ kind: "line", from, to }];
    case "arc": {
      const span = u1 - u0;
      if (span > 0.999999 && isClosed(p)) {
        // All the way round from one point: two halves (a three-point arc can't close on itself).
        const half = at(p, u0 + 0.5);
        return [
          { kind: "arc", from, mid: at(p, u0 + 0.25), to: half },
          { kind: "arc", from: half, mid: at(p, u0 + 0.75), to },
        ];
      }
      return [{ kind: "arc", from, mid: at(p, (u0 + u1) / 2), to }];
    }
    case "ellipse": {
      const t0 = p.t0 + (p.t1 - p.t0) * u0;
      const t1 = p.t0 + (p.t1 - p.t0) * u1;
      const g = p.g;
      if (u1 - u0 > 0.999999 && p.closed) {
        const tm = (t0 + t1) / 2;
        const half = ellipseAt(g, tm);
        return [
          { kind: "ellipseArc", center: g.centre, rx: g.rx, ry: g.ry, angle: g.angle, t0, t1: tm, from, to: half },
          { kind: "ellipseArc", center: g.centre, rx: g.rx, ry: g.ry, angle: g.angle, t0: tm, t1, from: half, to },
        ];
      }
      return [{ kind: "ellipseArc", center: g.centre, rx: g.rx, ry: g.ry, angle: g.angle, t0, t1, from, to }];
    }
    case "bez": {
      const [, c1, c2] = subBezier(p.p, u0, u1);
      return [{ kind: "bezier", from, c1, c2, to }];
    }
  }
}

/** The part of a cubic Bézier from t0 to t1, as its own Bézier (de Casteljau). */
export function subBezier(b: Bez, t0: number, t1: number): Bez {
  const split = (q: Bez, t: number): [Bez, Bez] => {
    const l = (a: Pt, c: Pt): Pt => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
    const p01 = l(q[0], q[1]), p12 = l(q[1], q[2]), p23 = l(q[2], q[3]);
    const p012 = l(p01, p12), p123 = l(p12, p23);
    const m = l(p012, p123);
    return [
      [q[0], p01, p012, m],
      [m, p123, p23, q[3]],
    ];
  };
  const right = t0 > 0 ? split(b, t0)[1] : b;
  if (t1 >= 1) return right;
  return split(right, (t1 - t0) / (1 - t0))[0];
}

/** The pieces of segments, reversed (walked the other way). */
function reverseSegment(s: Segment): Segment {
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
}

/** The sketch's solid curves as primitives, and the id of the sketch curve each comes from. */
function primitives(sketch: SketchData): { prims: Prim[]; ids: string[] } {
  const pts = new Map<string, Pt>(sketch.points.map((p) => [p.id, [p.x, p.y]]));
  pts.set(ORIGIN_ID, [0, 0]);
  const prims: Prim[] = [];
  const ids: string[] = [];
  for (const c of sketch.curves) {
    if (c.construction) continue;
    const out = { push: (p: Prim) => (prims.push(p), ids.push(c.id)) };
    switch (c.type) {
      case "line": {
        const a = pts.get(c.p1), b = pts.get(c.p2);
        if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) out.push({ kind: "line", a, b });
        break;
      }
      case "circle": {
        const ctr = pts.get(c.center);
        if (ctr && c.radius > 1e-9) out.push({ kind: "arc", c: ctr, r: c.radius, a0: 0, a1: 2 * Math.PI, closed: true });
        break;
      }
      case "arc": {
        const ctr = pts.get(c.center), s = pts.get(c.start), e = pts.get(c.end);
        if (!ctr || !s || !e) break;
        const r = Math.hypot(s[0] - ctr[0], s[1] - ctr[1]);
        if (r <= 1e-9) break;
        const a0 = Math.atan2(s[1] - ctr[1], s[0] - ctr[0]);
        let a1 = Math.atan2(e[1] - ctr[1], e[0] - ctr[0]);
        while (a1 <= a0) a1 += 2 * Math.PI;
        // The arc's own end points, exactly (so it joins what it's joined to).
        out.push({ kind: "arc", c: ctr, r, a0, a1, closed: false });
        break;
      }
      case "ellipse": {
        const ctr = pts.get(c.center), mj = pts.get(c.major), mn = pts.get(c.minor);
        if (!ctr || !mj || !mn) break;
        const g = ellipseFrom(ctr, mj, mn);
        if (!(g.rx > 1e-9 && g.ry > 1e-9)) break;
        if (c.start && c.end) {
          // Part of an ellipse: anticlockwise from its start to its end.
          const span = ellipseSpan(sketch, c);
          out.push({ kind: "ellipse", g, t0: span.t0, t1: span.t1, closed: false });
        } else out.push({ kind: "ellipse", g, t0: 0, t1: 2 * Math.PI, closed: true });
        break;
      }
      case "spline": {
        if (c.points.length < 2 || (c.closed && c.points.length < 3)) break;
        const ps = c.points.map((id) => pts.get(id));
        if (ps.some((p) => !p)) break;
        const hs = splineHandles(c);
        for (const p of splineBeziers(ps as Pt[], c.closed, c.closed ? undefined : c.conic, hs, splineHandlesIn(c))) out.push({ kind: "bez", p });
        break;
      }
    }
  }
  // Text: each letter outline is a ring of straight pieces, going by its own id (the text's id and the outline's number).
  for (const t of textsOf(sketch)) {
    if (t.construction) continue;
    textContours(sketch, t).forEach((c, k) => {
      const id = textPieceId(t, k);
      c.forEach((a, i) => {
        const b = c[(i + 1) % c.length];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) {
          prims.push({ kind: "line", a, b });
          ids.push(id);
        }
      });
    });
  }
  return { prims, ids };
}

type Box = [number, number, number, number];
const boxOfPts = (poly: Pt[]): Box => {
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of poly) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  return b;
};
const boxesMeet = (a: Box, b: Box, e: number) => a[0] <= b[2] + e && b[0] <= a[2] + e && a[1] <= b[3] + e && b[1] <= a[3] + e;
const inBox = (p: Pt, b: Box, e: number) => p[0] >= b[0] - e && p[0] <= b[2] + e && p[1] >= b[1] - e && p[1] <= b[3] + e;

/** Where primitives p and q meet near (u, v), polished with Newton's method; null if they don't. */
function refineCrossing(p: Prim, q: Prim, u: number, v: number, tol: number): [number, number] | null {
  for (let i = 0; i < 30; i++) {
    const a = at(p, u), b = at(q, v);
    const fx = a[0] - b[0], fy = a[1] - b[1];
    if (Math.hypot(fx, fy) <= tol * 1e-3) break;
    const [du] = derivs(p, u);
    const [dv] = derivs(q, v);
    // J = [du, -dv]; solve J [δu δv] = -f.
    const det = du[0] * -dv[1] - -dv[0] * du[1];
    if (Math.abs(det) < 1e-18) break;
    const su = (-fx * -dv[1] - -dv[0] * -fy) / det;
    const sv = (du[0] * -fy - -fx * du[1]) / det;
    u += su;
    v += sv;
    if (!isClosed(p)) u = Math.max(-0.01, Math.min(1.01, u));
    if (!isClosed(q)) v = Math.max(-0.01, Math.min(1.01, v));
  }
  const a = at(p, u), b = at(q, v);
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > tol) return null;
  u = wrap(p, u);
  v = wrap(q, v);
  if (!isClosed(p) && (u < -1e-9 || u > 1 + 1e-9)) return null;
  if (!isClosed(q) && (v < -1e-9 || v > 1 + 1e-9)) return null;
  return [Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v))];
}

/** The parameter on p nearest to point x (near the seed u), and how far away it is. */
function project(p: Prim, x: Pt, u: number): { u: number; d: number } {
  for (let i = 0; i < 30; i++) {
    const a = at(p, u);
    const [d1, d2] = derivs(p, u);
    const ex = a[0] - x[0], ey = a[1] - x[1];
    const g = ex * d1[0] + ey * d1[1];
    const h = d1[0] * d1[0] + d1[1] * d1[1] + ex * d2[0] + ey * d2[1];
    if (Math.abs(h) < 1e-18) break;
    const step = g / (h > 0 ? h : d1[0] * d1[0] + d1[1] * d1[1]);
    u -= step;
    if (!isClosed(p)) u = Math.max(0, Math.min(1, u));
    if (Math.abs(step) < 1e-14) break;
  }
  u = wrap(p, u);
  const a = at(p, u);
  return { u, d: Math.hypot(a[0] - x[0], a[1] - x[1]) };
}

interface Edge {
  a: number;
  b: number;
  prim: number;
  u0: number;
  u1: number;
  /** From a to b, both ends included. */
  poly: Pt[];
}

/** One area: its outline, the outlines of the holes in it, and its size (outline minus holes). */
export interface SketchArea {
  outer: Loop;
  holes: Loop[];
  /** Area in mm², not counting its holes. */
  area: number;
  /** Its centre of area (holes taken out); may lie outside a hollow or bent shape. */
  centroid: Pt;
  /**
   * What bounds it: each sketch curve round its outline (not its holes, so a
   * plate with hundreds of holes stays short), with "+" when the area runs along
   * the curve's own direction and "-" against it (sorted). No two areas share an
   * outline, so this tells them apart. Moving or resizing the sketch keeps it;
   * changing what crosses what changes it.
   */
  signature: string[];
}

/** The areas of a sketch, and what's needed to join chosen ones into outlines. */
export interface AreaMap {
  areas: SketchArea[];
  /** Every solid (non-construction) curve id in the sketch (to tell when a curve a pick was bounded by has gone). */
  curves: Set<string>;
  /** The area containing a point (the smallest one round it), or -1. */
  areaAt(p: Pt): number;
  /** The chosen areas (by index) joined where they touch, ready to extrude. */
  join(chosen: number[]): Region[];
}

function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Centre of area of a polygon (either way round). */
function polygonCentroid(poly: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const k = x1 * y2 - x2 * y1;
    a += k;
    cx += (x1 + x2) * k;
    cy += (y1 + y2) * k;
  }
  if (Math.abs(a) < 1e-12) return poly[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Areas already found, per sketch (sketches are never changed in place, so the same object means the same areas). */
const found = new WeakMap<SketchData, AreaMap>();

/** Find the areas formed by a sketch's solid curves (worked out once per sketch). */
export function sketchAreas(sketch: SketchData): AreaMap {
  let map = found.get(sketch);
  if (!map) {
    map = findAreas(sketch);
    found.set(sketch, map);
  }
  return map;
}

function findAreas(sketch: SketchData): AreaMap {
  const { prims, ids: curveOf } = primitives(sketch);
  const samples = prims.map((p) => {
    const n = stepsOf(p);
    const us: number[] = [];
    const ps: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      us.push(i / n);
      ps.push(at(p, i / n));
    }
    return { us, ps, box: boxOfPts(ps) };
  });
  let size = 1;
  for (const s of samples) for (const v of s.box) size = Math.max(size, Math.abs(v));
  const tol = 1e-6 * Math.max(10, size);

  // Where each primitive is cut (by u).
  const cuts: number[][] = prims.map((p) => (isClosed(p) ? [] : [0, 1]));
  const addCut = (i: number, u: number) => cuts[i].push(u);

  // Crossings between every pair whose boxes meet (straight-piece crossings polished exactly).
  for (let i = 0; i < prims.length; i++) {
    for (let j = i + 1; j < prims.length; j++) {
      if (!boxesMeet(samples[i].box, samples[j].box, tol)) continue;
      const A = samples[i], B = samples[j];
      for (let s = 0; s + 1 < A.ps.length; s++) {
        const p = A.ps[s], p2 = A.ps[s + 1];
        const sb: Box = [Math.min(p[0], p2[0]), Math.min(p[1], p2[1]), Math.max(p[0], p2[0]), Math.max(p[1], p2[1])];
        if (!boxesMeet(sb, B.box, tol)) continue;
        const r: Pt = [p2[0] - p[0], p2[1] - p[1]];
        for (let k = 0; k + 1 < B.ps.length; k++) {
          const q = B.ps[k], q2 = B.ps[k + 1];
          const w: Pt = [q2[0] - q[0], q2[1] - q[1]];
          const den = r[0] * w[1] - r[1] * w[0];
          if (Math.abs(den) < 1e-15) continue;
          const qp: Pt = [q[0] - p[0], q[1] - p[1]];
          const t = (qp[0] * w[1] - qp[1] * w[0]) / den;
          const v = (qp[0] * r[1] - qp[1] * r[0]) / den;
          if (t < -0.05 || t > 1.05 || v < -0.05 || v > 1.05) continue;
          const u0 = A.us[s] + (A.us[s + 1] - A.us[s]) * t;
          const v0 = B.us[k] + (B.us[k + 1] - B.us[k]) * v;
          const hit = refineCrossing(prims[i], prims[j], u0, v0, tol);
          if (hit) {
            addCut(i, hit[0]);
            addCut(j, hit[1]);
          }
        }
      }
    }
  }

  // Ends lying on another curve (a T): cut that curve there too.
  const ends: { p: Pt; prim: number }[] = [];
  prims.forEach((p, i) => {
    if (isClosed(p)) return;
    ends.push({ p: at(p, 0), prim: i }, { p: at(p, 1), prim: i });
  });
  for (const e of ends) {
    for (let j = 0; j < prims.length; j++) {
      if (j === e.prim || !inBox(e.p, samples[j].box, tol)) continue;
      // Seed from the nearest sample.
      const S = samples[j];
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < S.ps.length; k++) {
        const d = Math.hypot(S.ps[k][0] - e.p[0], S.ps[k][1] - e.p[1]);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      const pr = project(prims[j], e.p, S.us[best]);
      if (pr.d <= tol) addCut(j, pr.u);
    }
  }

  // Merge nearby points into vertices.
  const vpos: Pt[] = [];
  const grid = new Map<string, number[]>();
  const cell = tol * 4;
  const vertexAt = (p: Pt): number => {
    const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const v of grid.get(`${gx + dx},${gy + dy}`) ?? []) if (Math.hypot(vpos[v][0] - p[0], vpos[v][1] - p[1]) <= 2 * tol) return v;
    const id = vpos.length;
    vpos.push(p);
    const k = `${gx},${gy}`;
    grid.set(k, [...(grid.get(k) ?? []), id]);
    return id;
  };

  // Cut each primitive into edges.
  const edges: Edge[] = [];
  const seen = new Map<string, Pt[]>();
  prims.forEach((p, i) => {
    let us = [...cuts[i]].sort((a, b) => a - b);
    if (isClosed(p) && us.length === 0) us = [0];
    const verts = us.map((u) => vertexAt(at(p, u)));
    // Drop repeats (the same vertex twice in a row).
    const ku: number[] = [];
    const kv: number[] = [];
    us.forEach((u, k) => {
      if (kv.length && kv[kv.length - 1] === verts[k]) return;
      ku.push(u);
      kv.push(verts[k]);
    });
    if (isClosed(p)) {
      while (kv.length > 1 && kv[kv.length - 1] === kv[0]) {
        kv.pop();
        ku.pop();
      }
    }
    const pieces: [number, number, number, number][] = [];
    if (isClosed(p)) {
      for (let k = 0; k < ku.length; k++) {
        const n = (k + 1) % ku.length;
        const u1 = n === 0 ? ku[0] + 1 : ku[n];
        pieces.push([ku[k], u1, kv[k], kv[n]]);
      }
    } else {
      for (let k = 0; k + 1 < ku.length; k++) pieces.push([ku[k], ku[k + 1], kv[k], kv[k + 1]]);
    }
    const base = stepsOf(p);
    for (const [u0, u1, a, b] of pieces) {
      const steps = Math.max(p.kind === "line" ? 1 : 2, Math.ceil((u1 - u0) * base));
      const poly: Pt[] = [vpos[a]];
      for (let s = 1; s < steps; s++) poly.push(at(p, wrap(p, u0 + ((u1 - u0) * s) / steps)));
      poly.push(vpos[b]);
      let len = 0;
      for (let s = 1; s < poly.length; s++) len += Math.hypot(poly[s][0] - poly[s - 1][0], poly[s][1] - poly[s - 1][1]);
      if (len <= 2 * tol) continue;
      // The same piece drawn twice (overlapping curves) counts once.
      const mid = at(p, wrap(p, (u0 + u1) / 2));
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      const mids = seen.get(key) ?? [];
      if (mids.some((m) => Math.hypot(m[0] - mid[0], m[1] - mid[1]) <= 10 * tol)) continue;
      seen.set(key, [...mids, mid]);
      edges.push({ a, b, prim: i, u0, u1, poly });
    }
  });

  // Drop loose ends and bridges (edges that don't go round anything), until none are left.
  const alive = edges.map(() => true);
  for (let pass = 0; pass < 100; pass++) {
    let changed = false;
    // Loose ends.
    for (;;) {
      const deg = new Array<number>(vpos.length).fill(0);
      edges.forEach((e, i) => {
        if (!alive[i]) return;
        deg[e.a]++;
        deg[e.b]++;
      });
      let any = false;
      edges.forEach((e, i) => {
        if (alive[i] && (deg[e.a] === 1 || deg[e.b] === 1)) {
          alive[i] = false;
          any = true;
        }
      });
      if (!any) break;
      changed = true;
    }
    // Bridges (Tarjan, without recursion).
    const adj: number[][] = vpos.map(() => []);
    edges.forEach((e, i) => {
      if (!alive[i]) return;
      adj[e.a].push(i);
      if (e.b !== e.a) adj[e.b].push(i);
    });
    const disc = new Array<number>(vpos.length).fill(-1);
    const low = new Array<number>(vpos.length).fill(0);
    let time = 0;
    for (let root = 0; root < vpos.length; root++) {
      if (disc[root] >= 0 || !adj[root].length) continue;
      const stack: { v: number; via: number; k: number }[] = [{ v: root, via: -1, k: 0 }];
      disc[root] = low[root] = time++;
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.k < adj[top.v].length) {
          const ei = adj[top.v][top.k++];
          if (ei === top.via) continue;
          const e = edges[ei];
          const w = e.a === top.v ? e.b : e.a;
          if (w === top.v) continue; // a loop on itself
          if (disc[w] < 0) {
            disc[w] = low[w] = time++;
            stack.push({ v: w, via: ei, k: 0 });
          } else low[top.v] = Math.min(low[top.v], disc[w]);
        } else {
          stack.pop();
          if (stack.length) {
            const parent = stack[stack.length - 1];
            low[parent.v] = Math.min(low[parent.v], low[top.v]);
            if (low[top.v] > disc[parent.v]) {
              alive[top.via] = false;
              changed = true;
            }
          }
        }
      }
    }
    if (!changed) break;
  }

  // Half-edges: 2i runs a→b, 2i+1 runs b→a. Sort each vertex's outgoing ones by direction.
  const live = edges.map((_e, i) => i).filter((i) => alive[i]);
  const head = (h: number) => (h & 1 ? edges[h >> 1].a : edges[h >> 1].b);
  const tail = (h: number) => (h & 1 ? edges[h >> 1].b : edges[h >> 1].a);
  const leaving = (h: number): { angle: number; curve: number } => {
    const e = edges[h >> 1];
    const p = prims[e.prim];
    const fwd = (h & 1) === 0;
    const u = wrap(p, fwd ? e.u0 : e.u1);
    let [d1, d2] = derivs(p, u);
    if (!fwd) d1 = [-d1[0], -d1[1]];
    const sp = Math.hypot(d1[0], d1[1]) || 1;
    let curve = (d1[0] * d2[1] - d1[1] * d2[0]) / (sp * sp * sp);
    // Walking backwards, d2 keeps its sign but d1 flips, so the bend's sign flips (handled by d1's flip above).
    let angle = Math.atan2(d1[1], d1[0]);
    if (angle > Math.PI - 1e-9) angle = -Math.PI;
    if (!Number.isFinite(curve)) curve = 0;
    return { angle, curve };
  };
  const out: number[][] = vpos.map(() => []);
  const key = new Map<number, { angle: number; curve: number }>();
  for (const i of live) {
    for (const h of [2 * i, 2 * i + 1]) {
      out[tail(h)].push(h);
      key.set(h, leaving(h));
    }
  }
  const slot = new Map<number, number>();
  out.forEach((list) => {
    list.sort((x, y) => {
      const kx = key.get(x)!, ky = key.get(y)!;
      const d = kx.angle - ky.angle;
      if (Math.abs(d) > 1e-9) return d;
      return kx.curve - ky.curve;
    });
    list.forEach((h, k) => slot.set(h, k));
  });
  /** Next half-edge round the face on the left: the one just clockwise of the way back. */
  const nextOf = (h: number, ok?: (g: number) => boolean): number => {
    const v = head(h);
    const list = out[v];
    let k = slot.get(h ^ 1)!;
    for (let n = 0; n < list.length; n++) {
      k = (k - 1 + list.length) % list.length;
      const g = list[k];
      if (!ok || ok(g)) return g;
    }
    return h ^ 1;
  };
  const polyOf = (h: number): Pt[] => {
    const e = edges[h >> 1];
    return h & 1 ? [...e.poly].reverse() : e.poly;
  };
  /**
   * A cycle's half-edges as runs along their curves: neighbouring pieces of the
   * same curve join up again (so a side cut where another area met it is still
   * one straight side). Each run goes from vertex `from` to `to`, walking the
   * curve from u0 to u1 (fwd) or back from u1 to u0.
   */
  interface Run {
    prim: number;
    u0: number;
    u1: number;
    fwd: boolean;
    from: number;
    to: number;
  }
  const runsOf = (hs: number[]): Run[] => {
    const runs: Run[] = hs.map((h) => {
      const e = edges[h >> 1];
      const fwd = (h & 1) === 0;
      return { prim: e.prim, u0: e.u0, u1: e.u1, fwd, from: fwd ? e.a : e.b, to: fwd ? e.b : e.a };
    });
    /** Does run b carry straight on along the same curve from where run a stops? */
    const follows = (a: Run, b: Run) => {
      if (a.prim !== b.prim || a.fwd !== b.fwd) return false;
      const gap = a.fwd ? b.u0 - a.u1 : a.u0 - b.u1;
      const g = isClosed(prims[a.prim]) ? gap - Math.round(gap) : gap;
      return Math.abs(g) < 1e-9;
    };
    const join = (a: Run, b: Run): Run => {
      const span = a.u1 - a.u0 + (b.u1 - b.u0);
      return a.fwd ? { ...a, u1: a.u0 + span, to: b.to } : { ...a, u0: b.u0, u1: b.u0 + span, to: b.to };
    };
    const out: Run[] = [];
    for (const r of runs) {
      const last = out[out.length - 1];
      if (last && follows(last, r)) out[out.length - 1] = join(last, r);
      else out.push(r);
    }
    // Round the end of the loop back to its start.
    while (out.length > 1 && follows(out[out.length - 1], out[0])) out[0] = join(out.pop()!, out[0]);
    return out;
  };

  interface Cycle {
    hs: number[];
    poly: Pt[];
    area: number;
    box: Box;
  }
  const trace = (start: number, ok?: (g: number) => boolean): Cycle => {
    const hs: number[] = [];
    const poly: Pt[] = [];
    let h = start;
    do {
      hs.push(h);
      const pl = polyOf(h);
      for (let k = 0; k < pl.length - 1; k++) poly.push(pl[k]);
      h = nextOf(h, ok);
    } while (h !== start && hs.length <= 4 * edges.length + 4);
    return { hs, poly, area: signedArea(poly), box: boxOfPts(poly) };
  };

  /** A cycle as a sketch loop; a single whole circle or ellipse stays whole. */
  const loopOf = (c: Cycle): Loop => {
    let segments: Segment[];
    const only = c.hs.length === 1 ? edges[c.hs[0] >> 1] : null;
    const whole = only && isClosed(prims[only.prim]) && only.u1 - only.u0 > 0.999999 ? prims[only.prim] : null;
    if (whole?.kind === "arc") segments = [{ kind: "circle", center: whole.c, radius: whole.r }];
    else if (whole?.kind === "ellipse") segments = [{ kind: "ellipse", center: whole.g.centre, rx: whole.g.rx, ry: whole.g.ry, angle: whole.g.angle }];
    else segments = runsOf(c.hs).flatMap((r) => {
      // pieceSegment runs from u0 to u1; a run walked backwards starts at the u1 end.
      return r.fwd
        ? pieceSegment(prims[r.prim], r.u0, r.u1, vpos[r.from], vpos[r.to])
        : pieceSegment(prims[r.prim], r.u0, r.u1, vpos[r.to], vpos[r.from]).reverse().map(reverseSegment);
    });
    const polygon = c.area < 0 ? [...c.poly].reverse() : [...c.poly];
    return { segments, polygon, area: Math.abs(c.area) };
  };

  // Every face: anticlockwise cycles are areas; clockwise ones are the outsides of connected shapes.
  const done = new Set<number>();
  const faces: Cycle[] = [];
  const outsides: Cycle[] = [];
  const faceOfHalf = new Map<number, number>();
  for (const i of live) {
    for (const h of [2 * i, 2 * i + 1]) {
      if (done.has(h)) continue;
      const c = trace(h);
      c.hs.forEach((x) => done.add(x));
      if (c.area > tol * tol) {
        c.hs.forEach((x) => faceOfHalf.set(x, faces.length));
        faces.push(c);
      } else outsides.push(c);
    }
  }

  // Which connected shape each vertex is in.
  const group = vpos.map((_p, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
  for (const i of live) group[find(edges[i].a)] = find(edges[i].b);
  const faceGroup = faces.map((f) => find(tail(f.hs[0])));

  /** The smallest area (from another connected shape than `skip`) whose outline goes round p. */
  const smallestAround = (p: Pt, skip: number): number => {
    let best = -1;
    for (let f = 0; f < faces.length; f++) {
      if (faceGroup[f] === skip || !inBox(p, faces[f].box, 0)) continue;
      if (best >= 0 && faces[f].area >= faces[best].area) continue;
      if (pointInPolygon(p, faces[f].poly)) best = f;
    }
    return best;
  };

  // Each connected shape's outside lies in the area round it (or nowhere): a hole in that area.
  const holesOf: number[][] = faces.map(() => []);
  outsides.forEach((c, k) => {
    const g = find(tail(c.hs[0]));
    const parent = smallestAround(vpos[tail(c.hs[0])], g);
    c.hs.forEach((x) => faceOfHalf.set(x, parent));
    if (parent >= 0) holesOf[parent].push(k);
  });

  const areas: SketchArea[] = faces.map((f, i) => {
    const holes = holesOf[i].map((k) => loopOf(outsides[k]));
    const area = f.area - holes.reduce((s, h) => s + h.area, 0);
    // Centre of area: the outline's, less each hole's.
    const [ox, oy] = polygonCentroid(f.poly);
    let mx = ox * f.area;
    let my = oy * f.area;
    for (const h of holes) {
      const [hx, hy] = polygonCentroid(h.polygon);
      mx -= hx * h.area;
      my -= hy * h.area;
    }
    const centroid: Pt = area > 1e-12 ? [mx / area, my / area] : [ox, oy];
    const sides = new Set<string>();
    for (const h of f.hs) sides.add(`${curveOf[edges[h >> 1].prim]}${h & 1 ? "-" : "+"}`);
    return { outer: loopOf(f), holes, area, centroid, signature: [...sides].sort() };
  });

  const areaAt = (p: Pt): number => smallestAround(p, -1);

  const join = (chosen: number[]): Region[] => {
    const pick = new Set(chosen.filter((i) => i >= 0 && i < faces.length));
    if (!pick.size) return [];
    const inPick = (h: number) => pick.has(faceOfHalf.get(h) ?? -1);
    // The outline of the chosen areas: edges with a chosen area on one side only.
    const edge = (h: number) => inPick(h) && !inPick(h ^ 1);
    const used = new Set<number>();
    const outers: Cycle[] = [];
    const inners: Cycle[] = [];
    for (const i of live) {
      for (const h of [2 * i, 2 * i + 1]) {
        if (used.has(h) || !edge(h)) continue;
        const c = trace(h, edge);
        c.hs.forEach((x) => used.add(x));
        (c.area > 0 ? outers : inners).push(c);
      }
    }
    const regions: Region[] = outers.map((c) => ({ outer: loopOf(c), holes: [] }));
    for (const c of inners) {
      // A point partway along one of its pieces (not a corner, which an outline may share).
      const pl = polyOf(c.hs[0]);
      const p: Pt = [(pl[0][0] + pl[1][0]) / 2, (pl[0][1] + pl[1][1]) / 2];
      let best = -1;
      outers.forEach((o, k) => {
        if (!inBox(p, o.box, 0) || (best >= 0 && o.area >= outers[best].area)) return;
        if (pointInPolygon(p, o.poly)) best = k;
      });
      if (best >= 0) regions[best].holes.push(loopOf(c));
    }
    return regions;
  };

  // Only solid curves bound anything: one turned into construction counts as gone.
  const curves = new Set(sketch.curves.filter((c) => !c.construction).map((c) => c.id));
  for (const t of textsOf(sketch)) if (!t.construction) textContours(sketch, t).forEach((_c, k) => curves.add(textPieceId(t, k)));
  return { areas, areaAt, join, curves };
}

/** Distance from p to the nearest edge of a closed polygon. */
function distanceToOutline(p: Pt, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const dx = poly[i][0] - ax, dy = poly[i][1] - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]));
  }
  return best;
}

/**
 * A point well inside an area (far from its edges), to remember it by: small
 * changes to the sketch then still find the same area.
 */
export function pointInside(a: SketchArea): Pt {
  const holeBoxes = a.holes.map((h) => boxOfPts(h.polygon));
  const inside = (p: Pt) => pointInPolygon(p, a.outer.polygon) && !a.holes.some((h, i) => inBox(p, holeBoxes[i], 0) && pointInPolygon(p, h.polygon));
  const clearance = (p: Pt) => {
    let d = distanceToOutline(p, a.outer.polygon);
    a.holes.forEach((h, i) => {
      // Skip holes whose box is further away than the nearest edge so far.
      const b = holeBoxes[i];
      const dx = Math.max(b[0] - p[0], 0, p[0] - b[2]);
      const dy = Math.max(b[1] - p[1], 0, p[1] - b[3]);
      if (Math.hypot(dx, dy) < d) d = Math.min(d, distanceToOutline(p, h.polygon));
    });
    return d;
  };
  const box = boxOfPts(a.outer.polygon);
  let best: Pt | null = null;
  let bestD = -1;
  let [x0, y0, x1, y1] = box;
  for (let round = 0; round < 3; round++) {
    const n = 16;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const p: Pt = [x0 + ((x1 - x0) * (i + 0.5)) / (n + 1), y0 + ((y1 - y0) * (j + 0.5)) / (n + 1)];
        if (!inside(p)) continue;
        const d = clearance(p);
        // Of equally clear places (a long strip has a whole line of them), the one nearest the centre.
        const tie = Math.abs(d - bestD) <= 1e-3 * bestD;
        if ((d > bestD && !tie) || (tie && best && Math.hypot(p[0] - a.centroid[0], p[1] - a.centroid[1]) < Math.hypot(best[0] - a.centroid[0], best[1] - a.centroid[1]))) {
          bestD = Math.max(d, bestD);
          best = p;
        }
      }
    }
    if (!best) break;
    // Look closer round the best point so far.
    const w = (x1 - x0) / 4, h = (y1 - y0) / 4;
    [x0, y0, x1, y1] = [best[0] - w, best[1] - h, best[0] + w, best[1] + h];
  }
  if (!best) {
    // A very thin area: the middle of its first edge's side, nudged in.
    const p = a.outer.polygon;
    best = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
  }
  // Kept short in the file: to a ten-thousandth of the area's own size.
  return [roundTo(best[0], Math.sqrt(a.area) * 1e-4), roundTo(best[1], Math.sqrt(a.area) * 1e-4)];
}

/** x rounded to a tidy step (a power of ten) no bigger than `size`. */
function roundTo(x: number, size: number): number {
  const step = 10 ** Math.floor(Math.log10(Math.max(size, 1e-9)));
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  return Number((Math.round(x / step) * step).toFixed(Math.min(digits, 12)));
}

/**
 * How a picked area is remembered: a point well inside it, its size (mm²),
 * and its signature (what bounds it: see `SketchArea.signature`). Older picks
 * have just the point, or the point and size.
 */
export type AreaPick = [number, number] | [number, number, number, ...string[]];

/** The pick to remember an area by. */
export function pickOf(a: SketchArea): AreaPick {
  const [x, y] = pointInside(a);
  // Four significant figures are plenty to tell areas apart.
  const size = Number(a.area.toPrecision(4));
  return [x, y, size, ...a.signature];
}

/** Above this, the best match for a pick is too unlike it: the area has gone. */
const POOR_MATCH = 2;

/**
 * The area a pick with a signature means now: the one bounded by most of the
 * same curves, the same way round (shared ÷ all, of the two signatures), with
 * a bonus for being round the saved point and a small penalty for a different
 * size. None when a curve that bounded it has been deleted, or when no area
 * shares at least half its signature.
 */
function matchBySignature(map: AreaMap, p: Pt, size: number, signature: string[]): number {
  const mine = new Set(signature);
  // A curve that bounded it has gone: the area it was (say, half a plate split by a deleted line) is gone too.
  for (const s of mine) if (!map.curves.has(s.slice(0, -1))) return -1;
  const inside = map.areaAt(p);
  let best = -1;
  let bestScore = -Infinity;
  map.areas.forEach((a, i) => {
    let shared = 0;
    for (const s of a.signature) if (mine.has(s)) shared++;
    const overlap = shared / (mine.size + a.signature.length - shared);
    if (overlap < 0.5) return;
    const score = overlap + (i === inside ? 0.5 : 0) - (size > 0 && a.area > 0 ? 0.1 * Math.abs(Math.log(a.area / size)) : 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/**
 * The area a pick without a signature (older) means now (or -1 when nothing is like it any more). The
 * sketch may have changed since it was picked, so rather than just taking
 * the area the point is in, each area is scored by how far its centre is from
 * the point (compared with the picked area's size) and how different its size
 * is; the closest match wins, with being round the point as the tie-breaker.
 */
export function matchArea(map: AreaMap, pick: AreaPick | (number | string)[]): number {
  const [x, y, size] = pick as [number, number, number?];
  const signature = pick.slice(3).filter((v): v is string => typeof v === "string");
  if (signature.length) return matchBySignature(map, [x, y], size ?? 0, signature);
  if (size === undefined || !(size > 0)) return map.areaAt([x, y]);
  const scale = Math.sqrt(size);
  const inside = map.areaAt([x, y]);
  let best = -1;
  let bestScore = Infinity;
  map.areas.forEach((a, i) => {
    if (!(a.area > 0)) return;
    const d = Math.hypot(a.centroid[0] - x, a.centroid[1] - y) / scale;
    const score = d + Math.abs(Math.log(a.area / size)) - (i === inside ? 0.05 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return bestScore <= POOR_MATCH ? best : -1;
}

/**
 * The closed shapes to use for points picked inside areas: each point finds
 * the area it's in again, and areas side by side join up. `missing` counts
 * points no longer inside any area (the sketch changed round them).
 */
export function regionsAt(sketch: SketchData, points: (AreaPick | (number | string)[])[]): { regions: Region[]; missing: number } {
  const map = sketchAreas(sketch);
  const chosen: number[] = [];
  let missing = 0;
  for (const p of points) {
    const i = matchArea(map, p);
    if (i < 0) missing++;
    else if (!chosen.includes(i)) chosen.push(i);
  }
  return { regions: map.join(chosen), missing };
}

/**
 * The closed shapes a feature uses: every closed shape (`findRegions`), or,
 * when the user picked areas (`points`), just those. Throws a friendly error
 * when a picked area has gone.
 */
export function chosenRegions(sketch: SketchData, points: (AreaPick | (number | string)[])[] | undefined, verb: string): RegionResult {
  if (!points?.length) return findRegions(sketch);
  const r = regionsAt(sketch, points);
  if (r.missing) throw new Error(missingAreasMessage(r.missing, verb));
  return { regions: r.regions, problems: [] };
}

/** Plain-English message when picked areas have gone. */
export function missingAreasMessage(missing: number, verb: string): string {
  return `${missing === 1 ? "One of the areas" : `${missing} of the areas`} picked to ${verb} ${missing === 1 ? "isn't" : "aren't"} in the sketch any more (the sketch changed round ${missing === 1 ? "it" : "them"}). Edit this feature and click the areas again, or click "Use all closed shapes".`;
}

/** Which areas (by index) the picks mean now, and how many picks match nothing. */
export function pickedAreas(map: AreaMap, points: (AreaPick | (number | string)[])[] | undefined): { picked: Set<number>; missing: number } {
  const picked = new Set<number>();
  let missing = 0;
  for (const p of points ?? []) {
    const i = matchArea(map, p);
    if (i < 0) missing++;
    else picked.add(i);
  }
  return { picked, missing };
}

/**
 * Click an area in the picker: pick it (remembered by a point well inside it
 * and its size), or unpick it if it was picked. Picks whose area has gone are
 * dropped, and the others are brought up to date. No areas left means "every
 * closed shape" (undefined).
 */
export function toggleArea(map: AreaMap, points: (AreaPick | (number | string)[])[] | undefined, index: number): AreaPick[] | undefined {
  const now = new Set<number>();
  for (const p of points ?? []) {
    const i = matchArea(map, p);
    if (i >= 0) now.add(i);
  }
  if (now.has(index)) now.delete(index);
  else now.add(index);
  const next = [...now].map((i) => pickOf(map.areas[i]));
  return next.length ? next : undefined;
}

/**
 * Any point inside an area (not in a hole), found quickly: across the middle
 * of its outline's box, the widest stretch that's inside. No sketch curve
 * runs through an area, so any inside point says the same about it. Falls
 * back to the slower `pointInside` for a stretch-less (very thin) area.
 */
export function quickPointInside(a: SketchArea): Pt {
  const box = boxOfPts(a.outer.polygon);
  // A little off the middle, so the line is unlikely to pass exactly through a corner.
  const y = box[1] + (box[3] - box[1]) * 0.5123;
  const xs: number[] = [];
  for (const poly of [a.outer.polygon, ...a.holes.map((h) => h.polygon)]) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
    }
  }
  xs.sort((p, q) => p - q);
  let best: Pt | null = null;
  let width = 0;
  // Holes lie inside the outline and apart, so every other stretch is inside.
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > width) {
      width = xs[i + 1] - xs[i];
      best = [(xs[i] + xs[i + 1]) / 2, y];
    }
  }
  return best ?? pointInside(a);
}

/**
 * The areas "every closed shape" uses (no picks): those whose inside lies in
 * one of `findRegions`' shapes (inside its outline, not in one of its holes).
 * Kept quick for busy sketches (a plate with hundreds of holes): one cheap
 * inside point per area, and outlines whose box misses it aren't looked at.
 */
const usedByAll = new WeakMap<SketchData, Set<number>>();
export function areasUsedByAll(sketch: SketchData): Set<number> {
  const known = usedByAll.get(sketch);
  if (known) return known;
  const map = sketchAreas(sketch);
  const { regions } = findRegions(sketch);
  const shapes = regions.map((r) => ({ outer: r.outer.polygon, box: boxOfPts(r.outer.polygon), holes: r.holes.map((h) => ({ poly: h.polygon, box: boxOfPts(h.polygon) })) }));
  const inside = (p: Pt, poly: Pt[], box: Box) => inBox(p, box, 0) && pointInPolygon(p, poly);
  const used = new Set<number>();
  map.areas.forEach((a, i) => {
    const p = quickPointInside(a);
    if (shapes.some((r) => inside(p, r.outer, r.box) && !r.holes.some((h) => inside(p, h.poly, h.box)))) used.add(i);
  });
  usedByAll.set(sketch, used);
  return used;
}
