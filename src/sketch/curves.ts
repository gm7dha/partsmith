/**
 * Every sketch curve as a path you can walk along by one number (its
 * "parameter"): a line from 0 to 1, a circle or arc by angle, a spline piece by
 * piece (0 to the number of pieces), a conic from 0 to 1, an ellipse by its
 * own angle. Used to find exactly where curves cross, to cut splines and
 * ellipses into pieces that keep their shape, and to offset them.
 */
import { ellipseAt, ellipseFrom, type EllipseGeom } from "./ellipse";
import { bezierAt, bezierBetween, bezierD1, bezierD2, conicAt, conicBetween, splineBeziers, splineTangents } from "./spline";
import { ORIGIN_ID, type SketchCurve, type SketchData, type SketchEllipse, type SketchPoint, type SketchSpline } from "./types";

export type P2 = [number, number];
type Bez = [P2, P2, P2, P2];

const TAU = Math.PI * 2;
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const len = (a: P2) => Math.hypot(a[0], a[1]);

export interface CurveParam {
  /** The parameter runs from lo to hi. */
  lo: number;
  hi: number;
  /** Comes back round to where it started (a circle, a whole ellipse, a closed spline). */
  closed: boolean;
  at(u: number): P2;
  d1(u: number): P2;
  d2(u: number): P2;
  /**
   * Derivatives arriving at u from below. Differ from d1/d2 only where a
   * spline's pieces join (its speed and bend may change there).
   */
  before?(u: number): { d1: P2; d2: P2 };
  /** Parameters to draw it through as short straight pieces (lo first, hi last). */
  samples: number[];
}

const posOf = (s: SketchData) => {
  const m = new Map<string, P2>(s.points.map((p) => [p.id, [p.x, p.y]]));
  return (id: string): P2 => (id === ORIGIN_ID ? [0, 0] : m.get(id) ?? [0, 0]);
};

const range = (lo: number, hi: number, n: number) => Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);

/** A spline's handles (leaving and arriving), one entry per point. */
export function splineHandleLists(c: SketchSpline): { out: (P2 | undefined)[]; in: (P2 | undefined)[] } {
  return { out: c.points.map((id) => c.tangents?.[id]), in: c.points.map((id) => c.tangentsIn?.[id]) };
}

/** A spline's Bézier pieces where its points are now. */
export function splinePieces(s: SketchData, c: SketchSpline): Bez[] {
  const P = posOf(s);
  const h = splineHandleLists(c);
  return splineBeziers(c.points.map(P), c.closed, c.conic, h.out, h.in);
}

/** Where along an ellipse a point is (its own angle t, so the point is centre + rx·cos t, ry·sin t on its turned axes). */
export function ellipseParam(g: EllipseGeom, p: P2): number {
  const c = Math.cos(g.angle), sn = Math.sin(g.angle);
  const q = sub(p, g.centre);
  const x = (q[0] * c + q[1] * sn) / (g.rx || 1e-12);
  const y = (-q[0] * sn + q[1] * c) / (g.ry || 1e-12);
  return Math.atan2(y, x);
}

/** An ellipse's span: whole (0…2π), or from its start round to its end. */
export function ellipseSpan(s: SketchData, c: SketchEllipse): { g: EllipseGeom; t0: number; t1: number; whole: boolean } {
  const P = posOf(s);
  const g = ellipseFrom(P(c.center), P(c.major), P(c.minor));
  if (!c.start || !c.end) return { g, t0: 0, t1: TAU, whole: true };
  const t0 = ellipseParam(g, P(c.start));
  let t1 = ellipseParam(g, P(c.end));
  while (t1 <= t0 + 1e-12) t1 += TAU;
  return { g, t0, t1, whole: false };
}

function ellipseD(g: EllipseGeom, t: number, k: 1 | 2): P2 {
  const c = Math.cos(g.angle), sn = Math.sin(g.angle);
  const [x, y] = k === 1 ? [-g.rx * Math.sin(t), g.ry * Math.cos(t)] : [-g.rx * Math.cos(t), -g.ry * Math.sin(t)];
  return [x * c - y * sn, x * sn + y * c];
}

/** The curve as a path walked by its parameter. */
export function curveParam(s: SketchData, c: SketchCurve): CurveParam {
  const P = posOf(s);
  if (c.type === "line") {
    const a = P(c.p1), b = P(c.p2);
    const d = sub(b, a);
    return { lo: 0, hi: 1, closed: false, at: (u) => [a[0] + d[0] * u, a[1] + d[1] * u], d1: () => d, d2: () => [0, 0], samples: [0, 1] };
  }
  if (c.type === "circle" || c.type === "arc") {
    const o = P(c.center);
    let r: number, a0 = 0, sweep = TAU;
    if (c.type === "circle") r = c.radius;
    else {
      const st = P(c.start), en = P(c.end);
      r = len(sub(st, o));
      a0 = Math.atan2(st[1] - o[1], st[0] - o[0]);
      sweep = Math.atan2(en[1] - o[1], en[0] - o[0]) - a0;
      while (sweep <= 0) sweep += TAU;
      while (sweep > TAU) sweep -= TAU;
    }
    return {
      lo: a0,
      hi: a0 + sweep,
      closed: c.type === "circle",
      at: (u) => [o[0] + r * Math.cos(u), o[1] + r * Math.sin(u)],
      d1: (u) => [-r * Math.sin(u), r * Math.cos(u)],
      d2: (u) => [-r * Math.cos(u), -r * Math.sin(u)],
      samples: range(a0, a0 + sweep, Math.max(8, Math.ceil((96 * sweep) / TAU))),
    };
  }
  if (c.type === "ellipse") {
    const { g, t0, t1, whole } = ellipseSpan(s, c);
    return {
      lo: t0,
      hi: t1,
      closed: whole,
      at: (u) => ellipseAt(g, u),
      d1: (u) => ellipseD(g, u, 1),
      d2: (u) => ellipseD(g, u, 2),
      samples: range(t0, t1, Math.max(16, Math.ceil((128 * (t1 - t0)) / TAU))),
    };
  }
  if (c.conic !== undefined && c.points.length === 3) {
    const [a, apex, b] = c.points.map(P);
    const rho = c.conic;
    return {
      lo: 0,
      hi: 1,
      closed: false,
      at: (u) => conicAt(a, apex, b, rho, u).p,
      d1: (u) => conicAt(a, apex, b, rho, u).d1,
      d2: (u) => conicAt(a, apex, b, rho, u).d2,
      samples: range(0, 1, 64),
    };
  }
  const pieces = splinePieces(s, c);
  const m = pieces.length;
  const piece = (u: number, fromBelow = false): [Bez, number] => {
    const i = Math.max(0, Math.min(m - 1, fromBelow ? Math.ceil(u) - 1 : Math.floor(u)));
    return [pieces[i], u - i];
  };
  return {
    lo: 0,
    hi: m,
    closed: c.closed,
    at: (u) => bezierAt(...piece(u)),
    d1: (u) => bezierD1(...piece(u)),
    d2: (u) => bezierD2(...piece(u)),
    before: (u) => ({ d1: bezierD1(...piece(u, true)), d2: bezierD2(...piece(u, true)) }),
    samples: range(0, m, Math.max(1, m) * 24),
  };
}

/** Signed bend of a path at u: + bending left (anticlockwise) as it runs, − right; 1 / radius. */
export function curvatureAt(p: CurveParam, u: number): number {
  const d1 = p.d1(u);
  const d2 = p.d2(u);
  const sp = len(d1);
  return sp < 1e-15 ? 0 : cross(d1, d2) / (sp * sp * sp);
}

/** Bring u into the path's range (going round, for a closed one). */
export function wrapParam(p: CurveParam, u: number): number {
  if (!p.closed) return Math.max(p.lo, Math.min(p.hi, u));
  const span = p.hi - p.lo;
  return p.lo + ((((u - p.lo) % span) + span) % span);
}

/** The parameter of the place on the path nearest to q. */
export function nearestParam(p: CurveParam, q: P2): number {
  let best = p.lo;
  let bestD = Infinity;
  const ss = p.samples;
  for (let i = 0; i + 1 < ss.length; i++) {
    const a = p.at(ss[i]);
    const b = p.at(ss[i + 1]);
    const d = sub(b, a);
    const l2 = dot(d, d);
    const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), d) / l2)) : 0;
    const f: P2 = [a[0] + d[0] * t, a[1] + d[1] * t];
    const dist = len(sub(f, q));
    if (dist < bestD) {
      bestD = dist;
      best = ss[i] + (ss[i + 1] - ss[i]) * t;
    }
  }
  // Newton steps on (point − q) · direction = 0.
  let u = best;
  for (let k = 0; k < 20; k++) {
    const r = sub(p.at(u), q);
    const d1 = p.d1(u);
    const f = dot(r, d1);
    const df = dot(d1, d1) + dot(r, p.d2(u));
    if (Math.abs(df) < 1e-15) break;
    const nu = wrapParam(p, u - f / df);
    if (Math.abs(nu - u) < 1e-14) {
      u = nu;
      break;
    }
    u = nu;
  }
  // Newton can wander off near a sharp bend: keep the sampled place if it's nearer (measured on the curve, not the straight piece).
  return len(sub(p.at(u), q)) <= len(sub(p.at(best), q)) + 1e-12 ? u : best;
}

export interface Crossing {
  p: P2;
  /** Parameters on the first and second path. */
  ua: number;
  ub: number;
}

/**
 * Where two paths cross: found on short straight pieces of each, then
 * homed in on the true curves (to a millionth of a micron or so).
 */
export function crossings(a: CurveParam, b: CurveParam): Crossing[] {
  const pa = a.samples.map((u) => a.at(u));
  const pb = b.samples.map((u) => b.at(u));
  const box = (pts: P2[], i: number) => [Math.min(pts[i][0], pts[i + 1][0]), Math.min(pts[i][1], pts[i + 1][1]), Math.max(pts[i][0], pts[i + 1][0]), Math.max(pts[i][1], pts[i + 1][1])];
  const bb = pb.slice(0, -1).map((_, j) => box(pb, j));
  const out: Crossing[] = [];
  const within = (p: CurveParam, u: number) => p.closed || (u >= p.lo - 1e-9 && u <= p.hi + 1e-9);
  for (let i = 0; i + 1 < pa.length; i++) {
    const ba = box(pa, i);
    const pad = 1e-9;
    for (let j = 0; j + 1 < pb.length; j++) {
      const q = bb[j];
      if (ba[0] > q[2] + pad || q[0] > ba[2] + pad || ba[1] > q[3] + pad || q[1] > ba[3] + pad) continue;
      const r = sub(pa[i + 1], pa[i]);
      const e = sub(pb[j + 1], pb[j]);
      const den = cross(r, e);
      if (Math.abs(den) < 1e-15) continue;
      const w = sub(pb[j], pa[i]);
      const t = cross(w, e) / den;
      const v = cross(w, r) / den;
      if (t < -1e-6 || t > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) continue;
      let ua = a.samples[i] + (a.samples[i + 1] - a.samples[i]) * t;
      let ub = b.samples[j] + (b.samples[j + 1] - b.samples[j]) * v;
      // Newton on a(ua) − b(ub) = 0.
      for (let k = 0; k < 30; k++) {
        const f = sub(a.at(ua), b.at(ub));
        if (len(f) < 1e-13) break;
        const da = a.d1(ua);
        const db = b.d1(ub);
        const det = -cross(da, db);
        if (Math.abs(det) < 1e-15) break;
        // [da, −db] [δa, δb]ᵀ = −f
        const dA = (-f[0] * -db[1] - -f[1] * -db[0]) / det;
        const dB = (da[0] * -f[1] - da[1] * -f[0]) / det;
        ua += dA;
        ub += dB;
        if (a.closed) ua = wrapParam(a, ua);
        if (b.closed) ub = wrapParam(b, ub);
      }
      if (!within(a, ua) || !within(b, ub)) continue;
      ua = wrapParam(a, ua);
      ub = wrapParam(b, ub);
      const p = a.at(ua);
      if (len(sub(p, b.at(ub))) > 1e-7) continue;
      if (out.some((c) => len(sub(c.p, p)) < 1e-7)) continue;
      out.push({ p, ua, ub });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pieces of splines, conics and ellipses

/** Are two handles the same (to a billionth of their size)? */
const same = (a: P2, b: P2) => len(sub(a, b)) <= 1e-9 * Math.max(1, len(a), len(b));

/**
 * A spline made from Bézier pieces joined end to end, through the given
 * point ids: handles are set only where the curve wouldn't run that way by
 * itself, so it follows the pieces exactly.
 */
export function splineThrough(id: string, ids: string[], pieces: Bez[], closed: boolean, construction: boolean): SketchSpline {
  const pts: P2[] = closed ? pieces.map((b) => b[0]) : [...pieces.map((b) => b[0]), pieces[pieces.length - 1][3]];
  const n = pts.length;
  const natural = splineTangents(pts, closed);
  const tangents: Record<string, P2> = {};
  const tangentsIn: Record<string, P2> = {};
  for (let i = 0; i < n; i++) {
    const leaving = i < pieces.length ? pieces[i] : null;
    const arriving = i > 0 ? pieces[i - 1] : closed ? pieces[pieces.length - 1] : null;
    const out: P2 | null = leaving ? [3 * (leaving[1][0] - leaving[0][0]), 3 * (leaving[1][1] - leaving[0][1])] : null;
    const inn: P2 | null = arriving ? [3 * (arriving[3][0] - arriving[2][0]), 3 * (arriving[3][1] - arriving[2][1])] : null;
    const first = (out ?? inn)!;
    if (!same(first, natural[i])) tangents[ids[i]] = first;
    if (out && inn && !same(inn, out)) tangentsIn[ids[i]] = inn;
  }
  return {
    id,
    type: "spline",
    points: ids,
    closed,
    construction,
    ...(Object.keys(tangents).length ? { tangents } : {}),
    ...(Object.keys(tangentsIn).length ? { tangentsIn } : {}),
  };
}

/** The Bézier pieces of a spline between parameters u0 and u1 (u1 may go past the end of a closed one, round to the start). */
function piecesBetween(all: Bez[], closed: boolean, u0: number, u1: number): Bez[] {
  const m = all.length;
  const out: Bez[] = [];
  const snap = (u: number) => (Math.abs(u - Math.round(u)) < 1e-9 ? Math.round(u) : u);
  let a = snap(u0);
  const b = snap(u1);
  while (a < b - 1e-12) {
    const i = Math.floor(a + 1e-12);
    const end = Math.min(b, i + 1);
    const piece = all[closed ? ((i % m) + m) % m : Math.min(i, m - 1)];
    out.push(bezierBetween(piece, a - i, end - i));
    a = end;
  }
  return out;
}

export interface CurvePiece {
  curve: SketchCurve;
  /** New points it needs (a conic's new corner). */
  points: SketchPoint[];
}

/**
 * The part of a spline, conic or ellipse from parameter u0 to u1 (u1 past
 * the end of a closed one goes round to the start), as a curve of its own
 * that follows the original exactly. `startId` and `endId` are the points
 * at its ends (already in the sketch, where the original is there); the
 * original's own points in between are kept.
 */
export function pieceOf(s: SketchData, c: SketchSpline | SketchEllipse, u0: number, u1: number, startId: string, endId: string, id: string, newPointId: () => string): CurvePiece {
  if (c.type === "ellipse") return { curve: { id, type: "ellipse", center: c.center, major: c.major, minor: c.minor, construction: c.construction, start: startId, end: endId }, points: [] };
  if (c.conic !== undefined && c.points.length === 3) {
    const P = posOf(s);
    const [a, apex, b] = c.points.map(P);
    const part = conicBetween(a, apex, b, c.conic, u0, u1);
    const apexId = Math.abs(u0) < 1e-12 && Math.abs(u1 - 1) < 1e-12 ? c.points[1] : newPointId();
    const points: SketchPoint[] = apexId === c.points[1] ? [] : [{ id: apexId, x: part.apex[0], y: part.apex[1] }];
    return { curve: { id, type: "spline", points: [startId, apexId, endId], closed: false, construction: c.construction, conic: part.rho }, points };
  }
  const all = splinePieces(s, c);
  const n = c.points.length;
  const pieces = piecesBetween(all, c.closed, u0, u1);
  // The original's points strictly inside the range keep their ids.
  const ids = [startId];
  for (let k = 1; k < pieces.length; k++) {
    const knot = Math.round(Math.floor(u0 + 1e-9) + k);
    ids.push(c.points[((knot % n) + n) % n]);
  }
  ids.push(endId);
  return { curve: splineThrough(id, ids, pieces, false, c.construction), points: [] };
}

// ---------------------------------------------------------------------------
// Offsets of splines and ellipses

/**
 * Where the offset of a path is at u: the path moved `dist` to its left
 * (negative: right), and how fast it runs there (arriving from below, with
 * `fromBelow`, which differs where a spline's pieces join).
 */
export function offsetAt(p: CurveParam, u: number, dist: number, fromBelow = false): { at: P2; d1: P2 } {
  const lim = fromBelow && p.before ? p.before(u) : { d1: p.d1(u), d2: p.d2(u) };
  const d1 = lim.d1;
  const sp = len(d1) || 1e-15;
  const n: P2 = [-d1[1] / sp, d1[0] / sp];
  const q = p.at(u);
  const bend = cross(d1, lim.d2) / (sp * sp * sp);
  const k = 1 - dist * bend;
  return { at: [q[0] + n[0] * dist, q[1] + n[1] * dist], d1: [d1[0] * k, d1[1] * k] };
}

/** The tightest bend of a path (largest |curvature| where bending towards `side`), sampled. */
export function tightestBend(p: CurveParam, side: number): number {
  let worst = 0;
  const n = Math.max(200, p.samples.length * 4);
  const bendBefore = (u: number) => {
    const b = p.before!(u);
    const sp = len(b.d1) || 1e-15;
    return cross(b.d1, b.d2) / (sp * sp * sp);
  };
  for (let i = 0; i <= n; i++) {
    const u = p.lo + ((p.hi - p.lo) * i) / n;
    worst = Math.max(worst, side * curvatureAt(p, u));
    // Where a spline's pieces join it can bend more arriving than leaving.
    if (p.before && i > 0) worst = Math.max(worst, side * bendBefore(u));
  }
  return worst;
}

/**
 * Bézier pieces following the offset of a path between consecutive
 * parameters `us`, each matching the offset's position and direction at its
 * ends (Hermite pieces).
 */
export function offsetPieces(p: CurveParam, dist: number, us: number[]): Bez[] {
  const out: Bez[] = [];
  for (let i = 0; i + 1 < us.length; i++) {
    const h = us[i + 1] - us[i];
    const a = offsetAt(p, us[i], dist);
    const b = offsetAt(p, us[i + 1], dist, true);
    out.push([a.at, [a.at[0] + (a.d1[0] * h) / 3, a.at[1] + (a.d1[1] * h) / 3], [b.at[0] - (b.d1[0] * h) / 3, b.at[1] - (b.d1[1] * h) / 3], b.at]);
  }
  return out;
}

/**
 * How far the pieces stray from the true offset: the largest difference
 * between their distance from the original path and `|dist|`, checked at
 * several places along each piece.
 */
export function offsetError(p: CurveParam, dist: number, us: number[], pieces: Bez[]): number {
  let worst = 0;
  pieces.forEach((b, i) => {
    for (const t of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
      const q = bezierAt(b, t);
      // The nearest place on the original, starting from where this piece came from.
      let u = us[i] + (us[i + 1] - us[i]) * t;
      for (let k = 0; k < 20; k++) {
        const r = sub(p.at(u), q);
        const d1 = p.d1(u);
        const f = dot(r, d1);
        const df = dot(d1, d1) + dot(r, p.d2(u));
        if (Math.abs(df) < 1e-15) break;
        const step = f / df;
        u -= step;
        if (Math.abs(step) < 1e-14) break;
      }
      worst = Math.max(worst, Math.abs(len(sub(p.at(u), q)) - Math.abs(dist)));
    }
  });
  return worst;
}

/** How closely offset copies of splines and ellipses follow the true offset (mm). */
export const OFFSET_TOLERANCE = 0.001;

/** Parameters to fit an offset through: the original's own pieces (for a spline), each split evenly until the fit is within `tol`. */
export function offsetParams(p: CurveParam, dist: number, tol = OFFSET_TOLERANCE, knots?: number[]): number[] {
  const base = knots ?? [p.lo, p.hi];
  for (let split = base.length > 2 ? 1 : 4; split <= 512; split *= 2) {
    const us: number[] = [];
    for (let i = 0; i + 1 < base.length; i++) for (let k = 0; k < split; k++) us.push(base[i] + ((base[i + 1] - base[i]) * k) / split);
    us.push(base[base.length - 1]);
    if (offsetError(p, dist, us, offsetPieces(p, dist, us)) <= tol) return us;
  }
  const us = range(p.lo, p.hi, 1024);
  return us;
}
