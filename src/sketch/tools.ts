/**
 * More sketch tools: slot, polygon, rounding a corner (sketch fillet) and trim.
 * Like ops.ts, each takes a sketch and returns a new, solved one (or an error
 * in plain English).
 */
import { evaluate } from "../model/expr";
import { solveSketch } from "./solver";
import { addArc, addCircle, addRectangle, circleThrough, curveById, curvePoints, deleteItems, ellipsePoints, isPointId, mirrorPoint, onCurveType, placePoint, pointPos, radiusOf, settle, sketchId, splinePath, type EditResult, type Placed } from "./ops";
import { minorPointFor } from "./ellipse";
import { ORIGIN_ID, type SketchEllipse, type SketchSpline, type SketchArc, type SketchCircle, type SketchConstraint, type SketchCurve, type SketchData, type SketchLine, type SketchPoint } from "./types";
import { toSketch, type PlaneFrame, type Vec3 } from "./planes";
import type { EdgeRef } from "../geometry/topoRef";
import { crossings, curveParam } from "./curves";
import { isWavy, offsetWavy, splitWavy, trimWavy } from "./curveEdits";

type P2 = [number, number];
const TAU = Math.PI * 2;
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
const len = (a: P2) => Math.hypot(a[0], a[1]);
const unit = (a: P2): P2 => mul(a, 1 / (len(a) || 1));
const cross = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
/** Angle normalised to [0, 2π). */
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

const con = (type: SketchConstraint["type"], refs: string[], value?: string, extra?: number[]): SketchConstraint => ({
  id: sketchId("c"),
  type,
  refs,
  ...(value !== undefined ? { value } : {}),
  ...(extra !== undefined ? { extra } : {}),
});

// ---------------------------------------------------------------------------
// Slot

/** A slot (rounded-end rectangle) between two centre points, `radius` = half its width. */
export function addSlot(s: SketchData, c1: Placed, c2: Placed, radius: number, construction = false): EditResult & { curveIds: string[]; axisId?: string } {
  const d = sub([c2.x, c2.y], [c1.x, c1.y]);
  if (len(d) < 1e-6) return { sketch: s, curveIds: [], error: "Click two different centre points for the slot." };
  if (radius < 1e-6) return { sketch: s, curveIds: [], error: "Move the pointer away from the centre line to give the slot a width." };
  const a = placePoint(s, c1);
  const b = placePoint(a.sketch, c2);
  if (a.id === b.id) return { sketch: s, curveIds: [], error: "Click two different centre points for the slot." };
  const n = mul([-unit(d)[1], unit(d)[0]], radius);
  const C1: P2 = [c1.x, c1.y];
  const C2: P2 = [c2.x, c2.y];
  const pts: SketchPoint[] = [add(C1, n), sub(C1, n), add(C2, n), sub(C2, n)].map(([x, y]) => ({ id: sketchId("p"), x, y }));
  const [a1, b1, a2, b2] = pts.map((p) => p.id);
  const ids = { axis: sketchId("l"), top: sketchId("l"), bottom: sketchId("l"), arc1: sketchId("a"), arc2: sketchId("a") };
  const curves: SketchCurve[] = [
    { id: ids.axis, type: "line", p1: a.id, p2: b.id, construction: true },
    { id: ids.top, type: "line", p1: a1, p2: a2, construction },
    { id: ids.bottom, type: "line", p1: b1, p2: b2, construction },
    { id: ids.arc1, type: "arc", center: a.id, start: a1, end: b1, construction },
    { id: ids.arc2, type: "arc", center: b.id, start: b2, end: a2, construction },
  ];
  const constraints = [
    con("tangent", [ids.top, ids.arc1]),
    con("tangent", [ids.top, ids.arc2]),
    con("tangent", [ids.bottom, ids.arc1]),
    con("tangent", [ids.bottom, ids.arc2]),
    con("equal", [ids.arc1, ids.arc2]),
  ];
  const sk = b.sketch;
  const r = settle({ points: [...sk.points, ...pts], curves: [...sk.curves, ...curves], constraints: [...sk.constraints, ...constraints] });
  return { ...r, curveIds: [ids.top, ids.bottom, ids.arc1, ids.arc2], axisId: ids.axis };
}

// ---------------------------------------------------------------------------
// Polygon

/** Where the polygon tool's pointer is the corners' corner points (by default) or the middle of one side. */
export type PolygonAcross = "corners" | "flats";

/** The polygon's corners: around `centre`, sized and turned by the pointer at `at` (a corner, or the middle of a side). */
export function polygonCorners(centre: P2, at: P2, sides: number, across: PolygonAcross = "corners"): P2[] {
  const n = Math.max(3, Math.round(sides));
  const d = len(sub(at, centre));
  const R = across === "flats" ? d / Math.cos(Math.PI / n) : d;
  const start = Math.atan2(at[1] - centre[1], at[0] - centre[0]) - (across === "flats" ? Math.PI / n : 0);
  return Array.from({ length: n }, (_, i) => [centre[0] + R * Math.cos(start + (TAU * i) / n), centre[1] + R * Math.sin(start + (TAU * i) / n)]);
}

/**
 * A regular polygon with `sides` corners, centred on `centre`. The pointer
 * `corner` is one corner, or with `across` = "flats" the middle of one side
 * (for sizing across flats, like a nut). Its size is held by a construction
 * circle through the corners, or touching the sides (`sizeCircleId`).
 */
export function addPolygon(
  s: SketchData,
  centre: Placed,
  corner: { x: number; y: number },
  sides: number,
  construction = false,
  across: PolygonAcross = "corners",
): EditResult & { lineIds: string[]; sizeCircleId?: string } {
  const n = Math.round(sides);
  if (!(n >= 3 && n <= 64)) return { sketch: s, lineIds: [], error: "A polygon needs between 3 and 64 sides." };
  if (Math.hypot(corner.x - centre.x, corner.y - centre.y) < 1e-6) return { sketch: s, lineIds: [], error: "Move the pointer away from the centre to give the polygon a size." };
  const corners = polygonCorners([centre.x, centre.y], [corner.x, corner.y], n, across);
  const R = len(sub(corners[0], [centre.x, centre.y]));
  const c = placePoint(s, centre);
  const pts: SketchPoint[] = corners.map(([x, y]) => ({ id: sketchId("p"), x, y }));
  const circleId = sketchId("k");
  const lineIds = pts.map(() => sketchId("l"));
  const curves: SketchCurve[] = [
    { id: circleId, type: "circle", center: c.id, radius: R, construction: true },
    ...pts.map((p, i): SketchLine => ({ id: lineIds[i], type: "line", p1: p.id, p2: pts[(i + 1) % n].id, construction })),
  ];
  const constraints = [...pts.map((p) => con("pointOnCircle", [p.id, circleId])), ...lineIds.slice(1).map((id) => con("equal", [lineIds[0], id]))];
  let sizeCircleId = circleId;
  if (across === "flats") {
    // A second construction circle touching the sides: its diameter is the size across flats.
    sizeCircleId = sketchId("k");
    curves.push({ id: sizeCircleId, type: "circle", center: c.id, radius: R * Math.cos(Math.PI / n), construction: true });
    constraints.push(con("tangent", [lineIds[0], sizeCircleId]));
  }
  const sk = c.sketch;
  return { ...settle({ points: [...sk.points, ...pts], curves: [...sk.curves, ...curves], constraints: [...sk.constraints, ...constraints] }), lineIds, sizeCircleId };
}

// ---------------------------------------------------------------------------
// Rounding a corner (sketch fillet)

/**
 * Round the corner where two straight lines meet at `pointId`. The corner
 * point stays as a "virtual sharp" so dimensions to it, and the lines'
 * length dimensions, keep working.
 */
export function filletCorner(original: SketchData, pointId: string, radiusText: string): EditResult & { arcId: string } {
  const fail = (error: string) => ({ sketch: original, arcId: "", error });
  const r = evaluate(radiusText);
  if (!r.ok) return fail(r.error);
  if (r.value <= 0) return fail("The radius must be more than 0.");
  // Lines joined by dragging one end onto the other have separate end points held together: make them one point first.
  const s = mergeCoincident(original, pointId);
  const meeting = s.curves.filter(
    (c): c is SketchLine | SketchArc => !c.construction && ((c.type === "line" && (c.p1 === pointId || c.p2 === pointId)) || (c.type === "arc" && (c.start === pointId || c.end === pointId))),
  );
  if (meeting.length === 2 && meeting.some((c) => c.type === "arc")) {
    const made = roundCurvedCorner(s, pointId, meeting[0], meeting[1], r.value, radiusText);
    return "error" in made ? fail(made.error) : made;
  }
  const lines = meeting.filter((c): c is SketchLine => c.type === "line");
  if (lines.length !== 2 || meeting.length !== 2) return fail("Click a corner where exactly two lines or arcs meet.");
  const [L1, L2] = lines;
  const P = pointPos(s, pointId);
  const far = (l: SketchLine) => (l.p1 === pointId ? l.p2 : l.p1);
  const A = pointPos(s, far(L1));
  const B = pointPos(s, far(L2));
  const u1 = unit(sub(A, P));
  const u2 = unit(sub(B, P));
  const phi = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (phi < 1e-3 || phi > Math.PI - 1e-3) return fail("Those lines are in a straight line, so there's no corner to round.");
  const half = phi / 2;
  const t = r.value / Math.tan(half);
  if (t >= len(sub(A, P)) - 1e-6 || t >= len(sub(B, P)) - 1e-6) return fail("That radius is too big for these lines — try a smaller one.");
  const T1 = add(P, mul(u1, t));
  const T2 = add(P, mul(u2, t));
  const C = add(P, mul(unit(add(u1, u2)), r.value / Math.sin(half)));

  const [t1, t2, c] = [T1, T2, C].map(([x, y]) => ({ id: sketchId("p"), x, y }));
  const arcId = sketchId("a");
  const ccw = cross(sub(T1, C), sub(T2, C)) > 0;
  const arc: SketchArc = { id: arcId, type: "arc", center: c.id, start: ccw ? t1.id : t2.id, end: ccw ? t2.id : t1.id, construction: false };
  const reroute = (l: SketchLine, to: string): SketchLine => (l.p1 === pointId ? { ...l, p1: to } : { ...l, p2: to });

  const constraints: SketchConstraint[] = s.constraints.map((k) =>
    // A length dimension on a trimmed line now measures to the virtual sharp instead.
    k.type === "length" && (k.refs[0] === L1.id || k.refs[0] === L2.id) ? { ...k, type: "distance", refs: [pointId, far(k.refs[0] === L1.id ? L1 : L2)] } : k,
  );
  constraints.push(
    con("pointOnLine", [pointId, L1.id]),
    con("pointOnLine", [pointId, L2.id]),
    con("tangent", [L1.id, arcId]),
    con("tangent", [L2.id, arcId]),
    con("radius", [arcId], radiusText),
  );
  const changed: SketchData = {
    points: [...s.points.map((p) => (p.id === pointId ? { ...p, standalone: true } : p)), t1, t2, c],
    curves: [...s.curves.map((k) => (k.id === L1.id ? reroute(L1, t1.id) : k.id === L2.id ? reroute(L2, t2.id) : k)), arc],
    constraints,
  };
  const solved = solveSketch(changed);
  if (!solved.ok) return fail("Rounding this corner would conflict with the sketch's other constraints.");
  return { sketch: solved.sketch, arcId };
}

/**
 * The sketch with every point held on `pointId` by a coincident constraint
 * (directly or through others) merged into it: curves and constraints that
 * used those points use `pointId` instead.
 */
export function mergeCoincident(s: SketchData, pointId: string): SketchData {
  const same = new Set([pointId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of s.constraints) {
      if (c.type !== "coincident" || !c.refs.some((r) => same.has(r))) continue;
      for (const r of c.refs) {
        if (r !== ORIGIN_ID && !same.has(r)) {
          same.add(r);
          grew = true;
        }
      }
    }
  }
  if (same.size === 1) return s;
  const to = (id: string) => (same.has(id) ? pointId : id);
  const curves = s.curves.map((c): SketchCurve => {
    switch (c.type) {
      case "line":
        return { ...c, p1: to(c.p1), p2: to(c.p2) };
      case "circle":
        return { ...c, center: to(c.center) };
      case "arc":
        return { ...c, center: to(c.center), start: to(c.start), end: to(c.end) };
      case "ellipse":
        return { ...c, center: to(c.center), major: to(c.major), minor: to(c.minor), ...(c.start && c.end ? { start: to(c.start), end: to(c.end) } : {}) };
      case "spline": {
        const remap = (h?: Record<string, [number, number]>) => (h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [to(k), v])) : undefined);
        const tangents = remap(c.tangents);
        const tangentsIn = remap(c.tangentsIn);
        return { ...c, points: c.points.map(to), ...(tangents ? { tangents } : {}), ...(tangentsIn ? { tangentsIn } : {}) };
      }
    }
  });
  const constraints = s.constraints
    .map((c) => ({ ...c, refs: c.refs.map(to) }))
    // Joins between the merged points are no longer needed.
    .filter((c) => !(c.type === "coincident" && c.refs[0] === c.refs[1]));
  const points = s.points.filter((p) => p.id === pointId || !same.has(p.id));
  return { points, curves, constraints };
}

/**
 * Round a corner where a line meets an arc, or two arcs meet: an arc of
 * `radius` touching both smoothly, each trimmed back to where it touches.
 */
function roundCurvedCorner(
  s: SketchData,
  pointId: string,
  k1: SketchLine | SketchArc,
  k2: SketchLine | SketchArc,
  radius: number,
  radiusText: string,
): { sketch: SketchData; arcId: string } | { error: string } {
  const P = pointPos(s, pointId);
  type Side = { kind: "line"; a: P2; d: P2 } | { kind: "circle"; c: P2; r: number };
  /** The curve moved `radius` to one side (+1 / −1): a parallel line, or a bigger/smaller circle. */
  const shifted = (k: SketchLine | SketchArc, sign: number): Side => {
    if (k.type === "line") {
      const a = pointPos(s, k.p1);
      const d = unit(sub(pointPos(s, k.p2), a));
      return { kind: "line", a: add(a, mul([-d[1], d[0]], sign * radius)), d };
    }
    return { kind: "circle", c: pointPos(s, k.center), r: radiusOf(s, k) + sign * radius };
  };
  /** Where the rounding touches curve `k` if its centre is at `f`, and whether that's on the part of `k` kept. */
  const touch = (k: SketchLine | SketchArc, f: P2): P2 | null => {
    if (k.type === "line") {
      const a = pointPos(s, k.p1);
      const b = pointPos(s, k.p2);
      const d = sub(b, a);
      const t = dot(sub(f, a), d) / (dot(d, d) || 1);
      return t > 1e-9 && t < 1 - 1e-9 ? add(a, mul(d, t)) : null;
    }
    const c = pointPos(s, k.center);
    const p = add(c, mul(unit(sub(f, c)), radiusOf(s, k)));
    // Strictly inside the arc (not at its ends).
    const [a0, sweep] = arcSpan(s, k);
    const at = norm(Math.atan2(p[1] - c[1], p[0] - c[0]) - a0);
    return at > 1e-9 && at < sweep - 1e-9 ? p : null;
  };
  const meet = (u: Side, w: Side): P2[] => {
    if (u.kind === "line" && w.kind === "line") {
      const hit = lineLine(u.a, u.d, w.a, w.d);
      return hit ? [hit] : [];
    }
    if (u.kind === "circle" && w.kind === "circle") {
      if (u.r <= 1e-9 || w.r <= 1e-9) return [];
      const d = len(sub(w.c, u.c));
      if (d < 1e-12 || d > u.r + w.r || d < Math.abs(u.r - w.r)) return [];
      const x = (d * d + u.r * u.r - w.r * w.r) / (2 * d);
      const h = Math.sqrt(Math.max(0, u.r * u.r - x * x));
      const e = unit(sub(w.c, u.c));
      const m = add(u.c, mul(e, x));
      return [add(m, mul([-e[1], e[0]], h)), sub(m, mul([-e[1], e[0]], h))];
    }
    const [l, c] = (u.kind === "line" ? [u, w] : [w, u]) as [Extract<Side, { kind: "line" }>, Extract<Side, { kind: "circle" }>];
    if (c.r <= 1e-9) return [];
    const f = sub(l.a, c.c);
    const b = dot(f, l.d);
    const disc = b * b - (dot(f, f) - c.r * c.r);
    if (disc < 0) return [];
    const q = Math.sqrt(disc);
    return [add(l.a, mul(l.d, -b - q)), add(l.a, mul(l.d, -b + q))];
  };
  let best: { f: P2; t1: P2; t2: P2; cost: number } | null = null;
  for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      for (const f of meet(shifted(k1, s1), shifted(k2, s2))) {
        const t1 = touch(k1, f);
        const t2 = touch(k2, f);
        if (!t1 || !t2) continue;
        // The rounding must sit in the corner: its touching points nearer the corner than anything else.
        const cost = len(sub(t1, P)) + len(sub(t2, P));
        if (!best || cost < best.cost) best = { f, t1, t2, cost };
      }
    }
  }
  if (!best) return { error: "That radius doesn't fit this corner — try a smaller one." };
  const { f, t1: T1, t2: T2 } = best;
  const [p1, p2, pc] = [T1, T2, f].map(([x, y]) => ({ id: sketchId("p"), x, y }));
  const arcId = sketchId("a");
  // The rounding turns the short way from one touching point to the other.
  const ccw = cross(sub(T1, f), sub(T2, f)) > 0;
  const fillet: SketchArc = { id: arcId, type: "arc", center: pc.id, start: ccw ? p1.id : p2.id, end: ccw ? p2.id : p1.id, construction: false };
  const reroute = (k: SketchLine | SketchArc, to: string): SketchCurve =>
    k.type === "line" ? (k.p1 === pointId ? { ...k, p1: to } : { ...k, p2: to }) : k.start === pointId ? { ...k, start: to } : { ...k, end: to };
  const far = (l: SketchLine) => (l.p1 === pointId ? l.p2 : l.p1);
  const constraints: SketchConstraint[] = s.constraints.map((k) => {
    // A trimmed line's length dimension measures to the corner (the virtual sharp) instead.
    const l = [k1, k2].find((c): c is SketchLine => c.type === "line" && k.type === "length" && k.refs[0] === c.id);
    return l ? { ...k, type: "distance", refs: [pointId, far(l)] } : k;
  });
  const tangentTo = (k: SketchLine | SketchArc, T: P2): SketchConstraint => {
    const t = con("tangent", [k.id, arcId]);
    // An arc and the rounding with their centres on the same side of where they touch: one sits inside the other.
    if (k.type === "arc") t.extra = [dot(sub(pointPos(s, k.center), T), sub(f, T)) > 0 ? 1 : 0];
    return t;
  };
  constraints.push(
    con(k1.type === "line" ? "pointOnLine" : "pointOnCircle", [pointId, k1.id]),
    con(k2.type === "line" ? "pointOnLine" : "pointOnCircle", [pointId, k2.id]),
    tangentTo(k1, T1),
    tangentTo(k2, T2),
    con("radius", [arcId], radiusText),
  );
  const changed: SketchData = {
    points: [...s.points.map((p) => (p.id === pointId ? { ...p, standalone: true } : p)), p1, p2, pc],
    curves: [...s.curves.map((k) => (k.id === k1.id ? reroute(k1, p1.id) : k.id === k2.id ? reroute(k2, p2.id) : k)), fillet],
    constraints,
  };
  const solved = solveSketch(changed);
  if (!solved.ok) return { error: "Rounding this corner would conflict with the sketch's other constraints." };
  return { sketch: solved.sketch, arcId };
}

// ---------------------------------------------------------------------------
// Trim

interface Cut {
  /** Position along the curve being trimmed (line: 0–1, arc/circle: angle from start). */
  at: number;
  point: P2;
  /** The curve that crosses it there. */
  by: string;
}

function circleOf(s: SketchData, c: SketchCircle | SketchArc): { c: P2; r: number } {
  return { c: pointPos(s, c.center), r: radiusOf(s, c) };
}

/** For an arc: [start angle, sweep] (anticlockwise). Circles: [0, 2π]. */
function arcSpan(s: SketchData, c: SketchCircle | SketchArc): [number, number] {
  if (c.type === "circle") return [0, TAU];
  const C = pointPos(s, c.center);
  const a0 = Math.atan2(pointPos(s, c.start)[1] - C[1], pointPos(s, c.start)[0] - C[0]);
  const a1 = Math.atan2(pointPos(s, c.end)[1] - C[1], pointPos(s, c.end)[0] - C[0]);
  const sweep = norm(a1 - a0);
  return [a0, sweep === 0 ? TAU : sweep];
}

/** Is the point (on the circle) within the arc's extent? */
function onArc(s: SketchData, c: SketchCircle | SketchArc, p: P2): boolean {
  if (c.type === "circle") return true;
  const { c: C } = circleOf(s, c);
  const [a0, sweep] = arcSpan(s, c);
  return norm(Math.atan2(p[1] - C[1], p[0] - C[0]) - a0) <= sweep + 1e-9;
}

/** Points where curves `a` and `b` cross (each within its own extent). */
export function intersections(s: SketchData, a: SketchCurve, b: SketchCurve): P2[] {
  // A spline or ellipse crossing anything: found on short straight pieces, then homed in on the true curves.
  if (isWavy(a) || isWavy(b)) return crossings(curveParam(s, a), curveParam(s, b)).map((c) => c.p);
  const seg = (l: SketchLine) => [pointPos(s, l.p1), pointPos(s, l.p2)] as [P2, P2];
  const onSeg = (l: SketchLine, p: P2) => {
    const [A, B] = seg(l);
    const t = dot(sub(p, A), sub(B, A)) / (dot(sub(B, A), sub(B, A)) || 1);
    return t >= -1e-9 && t <= 1 + 1e-9;
  };
  if (a.type === "line" && b.type === "line") {
    const [A, B] = seg(a);
    const [C, D] = seg(b);
    const r = sub(B, A);
    const q = sub(D, C);
    const den = cross(r, q);
    if (Math.abs(den) < 1e-12) return [];
    const t = cross(sub(C, A), q) / den;
    const u = cross(sub(C, A), r) / den;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? [add(A, mul(r, t))] : [];
  }
  if (a.type === "line" || b.type === "line") {
    const [l, k] = (a.type === "line" ? [a, b] : [b, a]) as [SketchLine, SketchCircle | SketchArc];
    const [A, B] = seg(l);
    const { c: C, r } = circleOf(s, k);
    const d = sub(B, A);
    const f = sub(A, C);
    const qa = dot(d, d);
    const qb = 2 * dot(f, d);
    const qc = dot(f, f) - r * r;
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0 || qa < 1e-12) return [];
    const root = Math.sqrt(disc);
    const ts = disc < 1e-12 ? [-qb / (2 * qa)] : [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)];
    return ts.filter((t) => t >= -1e-9 && t <= 1 + 1e-9).map((t) => add(A, mul(d, t))).filter((p) => onArc(s, k, p) && onSeg(l, p));
  }
  const ca = circleOf(s, a as SketchCircle | SketchArc);
  const cb = circleOf(s, b as SketchCircle | SketchArc);
  const d = len(sub(cb.c, ca.c));
  if (d < 1e-12 || d > ca.r + cb.r + 1e-9 || d < Math.abs(ca.r - cb.r) - 1e-9) return [];
  const x = (d * d + ca.r * ca.r - cb.r * cb.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, ca.r * ca.r - x * x));
  const e = unit(sub(cb.c, ca.c));
  const m = add(ca.c, mul(e, x));
  const pts: P2[] = h < 1e-9 ? [m] : [add(m, mul([-e[1], e[0]], h)), sub(m, mul([-e[1], e[0]], h))];
  return pts.filter((p) => onArc(s, a as SketchArc, p) && onArc(s, b as SketchArc, p));
}

/** Position of a point along a curve (line: 0–1; arc/circle: angle from its start). */
function paramOf(s: SketchData, c: SketchCurve, p: P2): number {
  if (c.type === "spline" || c.type === "ellipse") return 0;
  if (c.type === "line") {
    const A = pointPos(s, c.p1);
    const B = pointPos(s, c.p2);
    return dot(sub(p, A), sub(B, A)) / (dot(sub(B, A), sub(B, A)) || 1);
  }
  const { c: C } = circleOf(s, c);
  return norm(Math.atan2(p[1] - C[1], p[0] - C[0]) - arcSpan(s, c)[0]);
}

/** The end point of `c` sitting at p (to a millionth of a millimetre), if there is one. */
function endAt(s: SketchData, c: SketchCurve, p: P2): string | null {
  const ends = c.type === "line" ? [c.p1, c.p2] : c.type === "arc" ? [c.start, c.end] : c.type === "spline" ? (c.closed ? [] : [c.points[0], c.points[c.points.length - 1]]) : c.type === "ellipse" && c.start && c.end ? [c.start, c.end] : [];
  return ends.find((id) => id !== ORIGIN_ID && len(sub(pointPos(s, id), p)) < 1e-6) ?? null;
}

/** Constraints that stay true when a curve is shortened (others, like its length, are dropped). */
const KEEPS_WHEN_TRIMMED = new Set(["horizontal", "vertical", "parallel", "perpendicular", "tangent", "pointOnLine", "pointOnCircle", "concentric", "radius", "diameter", "equal", "fix", "offset", "pointOnCurve"]);

/**
 * Trim: remove the piece of a curve between the nearest crossings either
 * side of where it was clicked (or the whole curve if nothing crosses it).
 */
export function trimAt(s: SketchData, curveId: string, at: { x: number; y: number }): EditResult {
  const target = curveById(s, curveId);
  if (!target) return { sketch: s, error: "Click a line, arc or circle to trim." };
  if (isWavy(target)) return trimWavy(s, target, at);
  const cuts: Cut[] = [];
  for (const other of s.curves) {
    if (other.id === target.id) continue;
    for (const p of intersections(s, target, other)) cuts.push({ at: paramOf(s, target, p), point: p, by: other.id });
  }
  const click = paramOf(s, target, [at.x, at.y]);
  const end = target.type === "line" ? 1 : arcSpan(s, target)[1];
  const eps = target.type === "line" ? 1e-6 : 1e-6;
  const inside = target.type === "circle" ? cuts : cuts.filter((c) => c.at > eps && c.at < end - eps);
  if (inside.length === 0 || (target.type === "circle" && inside.length < 2)) return { sketch: deleteItems(s, [curveId]) };

  // Nearest crossings before and after the click.
  const before = inside.filter((c) => c.at < click).sort((a, b) => b.at - a.at)[0];
  const after = inside.filter((c) => c.at > click).sort((a, b) => a.at - b.at)[0];

  const reused = new Set<string>();
  const newPoint = (cut: Cut) => {
    const other = curveById(s, cut.by)!;
    // Where the other curve ends right on this one (a T), cut at its end point: no new point needed.
    const end = endAt(s, other, cut.point);
    if (end) {
      reused.add(end);
      return { point: { id: end, x: cut.point[0], y: cut.point[1] }, pts: [] as SketchPoint[], constraints: [] as SketchConstraint[] };
    }
    const id = sketchId("p");
    const on: SketchConstraint[] = [con(onCurveType(other), [id, cut.by])];
    const point = { id, x: cut.point[0], y: cut.point[1] };
    return { point, pts: [point], constraints: on };
  };
  // A shortened line is no longer equal in length to anything (an arc keeps its radius, so stays equal).
  // A reused end point is now the curve's own end, so it no longer needs holding on it.
  const keep0 = s.constraints.filter((k) => !k.refs.includes(curveId) || (KEEPS_WHEN_TRIMMED.has(k.type) && !(k.type === "equal" && target.type === "line")));
  const keep = () => keep0.filter((k) => !((k.type === "pointOnLine" || k.type === "pointOnCircle") && reused.has(k.refs[0]) && k.refs[1] === curveId));
  const others = s.curves.filter((c) => c.id !== curveId);

  if (target.type === "circle") {
    // Keep the arc from the crossing after the click round to the crossing before it.
    const sorted = [...inside].sort((a, b) => a.at - b.at);
    const lo = before ?? sorted[sorted.length - 1];
    const hi = after ?? sorted[0];
    const a = newPoint(hi);
    const b = newPoint(lo);
    const arc: SketchArc = { id: curveId, type: "arc", center: target.center, start: a.point.id, end: b.point.id, construction: target.construction };
    return settle({ points: [...s.points, ...a.pts, ...b.pts], curves: [...others, arc], constraints: [...keep(), ...a.constraints, ...b.constraints] });
  }

  const start = target.type === "line" ? target.p1 : target.start;
  const finish = target.type === "line" ? target.p2 : target.end;
  const piece = (from: string, to: string, id: string): SketchCurve =>
    target.type === "line" ? { ...target, id, p1: from, p2: to } : { ...target, id, start: from, end: to };

  if (!before && after) {
    const a = newPoint(after);
    return tidy(s, { points: [...s.points, ...a.pts], curves: [...others, piece(a.point.id, finish, curveId)], constraints: [...keep(), ...a.constraints] });
  }
  if (before && !after) {
    const b = newPoint(before);
    return tidy(s, { points: [...s.points, ...b.pts], curves: [...others, piece(start, b.point.id, curveId)], constraints: [...keep(), ...b.constraints] });
  }
  // A piece in the middle: split into two.
  const b = newPoint(before!);
  const a = newPoint(after!);
  const secondId = sketchId(target.type === "line" ? "l" : "a");
  const copied = keep()
    .filter((k) => k.refs.includes(curveId) && (k.type === "horizontal" || k.type === "vertical"))
    .map((k) => ({ ...k, id: sketchId("c"), refs: k.refs.map((r) => (r === curveId ? secondId : r)) }));
  return tidy(s, {
    points: [...s.points, ...b.pts, ...a.pts],
    curves: [...others, piece(start, b.point.id, curveId), piece(a.point.id, finish, secondId)],
    constraints: [...keep(), ...b.constraints, ...a.constraints, ...copied],
  });
}

/** Drop points nothing uses any more (and constraints on them), then solve. */
function tidy(before: SketchData, changed: SketchData): EditResult {
  const result = deleteItems(changed, []);
  const solved = solveSketch(result);
  if (!solved.ok) return { sketch: before, error: "Trimming there would conflict with the sketch's constraints." };
  return { sketch: solved.sketch };
}

// ---------------------------------------------------------------------------
// Offset

interface ChainStep {
  curve: SketchLine | SketchArc;
  /** Point the walk enters the curve at, and leaves at. */
  from: string;
  to: string;
}

/**
 * The run of lines and arcs joined end to end that contains `start`, in order
 * (a closed loop comes back to where it began). Construction geometry is ignored.
 */
export function chainOf(s: SketchData, start: SketchLine | SketchArc): { steps: ChainStep[]; closed: boolean } {
  const ends = (c: SketchLine | SketchArc): [string, string] => (c.type === "line" ? [c.p1, c.p2] : [c.start, c.end]);
  const usable = s.curves.filter((c): c is SketchLine | SketchArc => (c.type === "line" || c.type === "arc") && !c.construction);
  const at = new Map<string, (SketchLine | SketchArc)[]>();
  for (const c of usable) for (const p of ends(c)) at.set(p, [...(at.get(p) ?? []), c]);
  // A join is followed only where exactly two curves meet.
  const next = (c: SketchLine | SketchArc, p: string) => {
    const list = at.get(p) ?? [];
    return list.length === 2 ? list.find((x) => x !== c) ?? null : null;
  };
  const [a, b] = ends(start);
  const steps: ChainStep[] = [{ curve: start, from: a, to: b }];
  const seen = new Set([start.id]);
  // Forwards from b.
  let cur: SketchLine | SketchArc = start;
  let p = b;
  let closed = false;
  for (;;) {
    const n = next(cur, p);
    if (!n) break;
    if (n.id === start.id) {
      closed = true;
      break;
    }
    if (seen.has(n.id)) break;
    seen.add(n.id);
    const [na, nb] = ends(n);
    const to = na === p ? nb : na;
    steps.push({ curve: n, from: p, to });
    cur = n;
    p = to;
  }
  if (!closed) {
    // Backwards from a.
    cur = start;
    p = a;
    for (;;) {
      const n = next(cur, p);
      if (!n || seen.has(n.id)) break;
      seen.add(n.id);
      const [na, nb] = ends(n);
      const from = na === p ? nb : na;
      steps.unshift({ curve: n, from, to: p });
      cur = n;
      p = from;
    }
  }
  return { steps, closed };
}

/** Where two infinite lines (point + direction) cross, or null if they're parallel. */
function lineLine(p: P2, d: P2, q: P2, e: P2): P2 | null {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(q, p), e) / den;
  return add(p, mul(d, t));
}

/** Where a line (point + direction) meets a circle, the crossing nearest `near`. */
function lineCircle(p: P2, d: P2, c: P2, r: number, near: P2): P2 | null {
  const u = unit(d);
  const f = sub(p, c);
  const b = dot(f, u);
  const disc = b * b - (dot(f, f) - r * r);
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const hits = [add(p, mul(u, -b - s)), add(p, mul(u, -b + s))];
  return hits.sort((x, y) => len(sub(x, near)) - len(sub(y, near)))[0];
}

/** Where two circles meet, the crossing nearest `near`. */
function circleCircle(c1: P2, r1: number, c2: P2, r2: number, near: P2): P2 | null {
  const d = len(sub(c2, c1));
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return null;
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = unit(sub(c2, c1));
  const m = add(c1, mul(u, a));
  const hits = [add(m, mul([-u[1], u[0]], h)), sub(m, mul([-u[1], u[0]], h))];
  return hits.sort((x, y) => len(sub(x, near)) - len(sub(y, near)))[0];
}

/**
 * Offset a circle, or the whole run of joined lines and arcs that the clicked
 * curve belongs to, by `distanceText` towards the side the pointer is on
 * (`at`). New lines stay parallel to the originals and new arcs and circles
 * share the originals' centres, so the offset keeps its shape when the sketch
 * changes.
 */
export function offsetCurves(s: SketchData, curveId: string, at: { x: number; y: number }, distanceText: string): EditResult & { curveIds: string[] } {
  const fail = (error: string) => ({ sketch: s, curveIds: [], error });
  const r = evaluate(distanceText);
  if (!r.ok) return fail(r.error);
  if (r.value <= 0) return fail("The offset distance must be more than 0.");
  const dist = r.value;
  const clicked = curveById(s, curveId);
  if (!clicked) return fail("Click a line, arc or circle to offset.");
  if (isWavy(clicked)) return offsetWavy(s, clicked, at, distanceText);
  const P: P2 = [at.x, at.y];

  if (clicked.type === "circle") {
    const c = pointPos(s, clicked.center);
    const outward = len(sub(P, c)) > clicked.radius;
    const radius = clicked.radius + (outward ? dist : -dist);
    if (radius <= 1e-6) return fail("That offset is bigger than the circle — use a smaller distance, or offset outwards.");
    const id = sketchId("k");
    const circle: SketchCircle = { id, type: "circle", center: clicked.center, radius, construction: false };
    // The copy stays that far from the original when the original changes size.
    const keepApart: SketchConstraint = { ...con("offset", [id, clicked.id], distanceText), extra: [outward ? 1 : -1], labelOffset: { x: 0, y: 0 } };
    return { ...settle({ ...s, curves: [...s.curves, circle], constraints: [...s.constraints, keepApart] }), curveIds: [id] };
  }

  const { steps, closed } = chainOf(s, clicked);
  // Which side: the clicked curve's left (as the chain is walked) or right.
  const leftNormal = (step: ChainStep, near: P2): P2 => {
    if (step.curve.type === "line") {
      const d = unit(sub(pointPos(s, step.to), pointPos(s, step.from)));
      return [-d[1], d[0]];
    }
    const c = pointPos(s, step.curve.center);
    const out = unit(sub(near, c));
    // Walking an arc anticlockwise (start → end), its left is towards the centre.
    return step.from === step.curve.start ? mul(out, -1) : out;
  };
  const clickedStep = steps.find((st) => st.curve.id === clicked.id)!;
  const nearOnClicked: P2 = (() => {
    if (clickedStep.curve.type === "line") {
      const a = pointPos(s, clickedStep.from);
      const b = pointPos(s, clickedStep.to);
      const d = sub(b, a);
      const t = Math.max(0, Math.min(1, dot(sub(P, a), d) / (dot(d, d) || 1)));
      return add(a, mul(d, t));
    }
    const c = pointPos(s, clickedStep.curve.center);
    return add(c, mul(unit(sub(P, c)), radiusOf(s, clickedStep.curve)));
  })();
  const side = dot(sub(P, nearOnClicked), leftNormal(clickedStep, nearOnClicked)) >= 0 ? 1 : -1;
  const shift = side * dist;

  // Each curve moved sideways: lines along their left normal, arcs to a new radius.
  type Moved = { kind: "line"; a: P2; b: P2 } | { kind: "arc"; c: P2; r: number; a: P2; b: P2 };
  const moved: Moved[] = [];
  for (const st of steps) {
    const a = pointPos(s, st.from);
    const b = pointPos(s, st.to);
    if (st.curve.type === "line") {
      const n = leftNormal(st, a);
      moved.push({ kind: "line", a: add(a, mul(n, shift)), b: add(b, mul(n, shift)) });
    } else {
      const c = pointPos(s, st.curve.center);
      const r0 = radiusOf(s, st.curve);
      const r1 = st.from === st.curve.start ? r0 - shift : r0 + shift;
      if (r1 <= 1e-6) return fail("That offset is bigger than one of the arcs — use a smaller distance, or offset the other way.");
      moved.push({ kind: "arc", c, r: r1, a: add(c, mul(unit(sub(a, c)), r1)), b: add(c, mul(unit(sub(b, c)), r1)) });
    }
  }

  // Where neighbouring moved curves meet.
  const join = (m1: Moved, m2: Moved): P2 => {
    const e = m1.b;
    if (len(sub(e, m2.a)) < 1e-6) return e;
    let hit: P2 | null = null;
    if (m1.kind === "line" && m2.kind === "line") hit = lineLine(m1.a, sub(m1.b, m1.a), m2.a, sub(m2.b, m2.a));
    else if (m1.kind === "line" && m2.kind === "arc") hit = lineCircle(m1.a, sub(m1.b, m1.a), m2.c, m2.r, e);
    else if (m1.kind === "arc" && m2.kind === "line") hit = lineCircle(m2.a, sub(m2.b, m2.a), m1.c, m1.r, m2.a);
    else if (m1.kind === "arc" && m2.kind === "arc") hit = circleCircle(m1.c, m1.r, m2.c, m2.r, e);
    return hit ?? mul(add(e, m2.a), 0.5);
  };
  const n = moved.length;
  const corners: P2[] = [];
  // corners[i] = start of moved[i]; for an open chain the last end is extra.
  for (let i = 0; i < n; i++) {
    if (i === 0 && !closed) corners.push(moved[0].a);
    else corners.push(join(moved[(i - 1 + n) % n], moved[i]));
  }
  if (!closed) corners.push(moved[n - 1].b);
  const points: SketchPoint[] = corners.map(([x, y]) => ({ id: sketchId("p"), x, y }));
  const pid = (i: number) => points[closed ? i % n : i].id;

  const curves: SketchCurve[] = [];
  const constraints: SketchConstraint[] = [];
  /** [copy, original] pairs, held the offset distance apart. */
  const pairs: string[] = [];
  steps.forEach((st, i) => {
    const from = pid(i);
    const to = pid(i + 1);
    if (st.curve.type === "line") {
      const id = sketchId("l");
      curves.push({ id, type: "line", p1: from, p2: to, construction: false });
      constraints.push(con("parallel", [id, st.curve.id]));
      pairs.push(id, st.curve.id);
    } else {
      const id = sketchId("a");
      const forward = st.from === st.curve.start;
      curves.push({ id, type: "arc", center: st.curve.center, start: forward ? from : to, end: forward ? to : from, construction: false });
      pairs.push(id, st.curve.id);
    }
  });
  // One dimension holds every copy that far from its original, so the offset follows when the original changes.
  // The clicked curve's pair goes first: the label sits by it.
  const first = steps.findIndex((st) => st.curve.id === clicked.id);
  const ordered = [...pairs.slice(first * 2), ...pairs.slice(0, first * 2)];
  // Copies of pieces that joined smoothly join smoothly too (this also pins down where they meet).
  const tangents = (a: string, b: string) => s.constraints.find((k) => k.type === "tangent" && k.refs.includes(a) && k.refs.includes(b));
  for (let i = closed ? 0 : 1; i < steps.length; i++) {
    const prev = (i - 1 + steps.length) % steps.length;
    if (prev === i) continue;
    const t = tangents(steps[prev].curve.id, steps[i].curve.id);
    if (!t) continue;
    const [a, b] = [curves[prev].id, curves[i].id];
    const flip = t.refs[0] === steps[i].curve.id;
    constraints.push({ ...con("tangent", flip ? [b, a] : [a, b]), ...(t.extra ? { extra: [...t.extra] } : {}) });
  }
  const drafted: SketchData = { points: [...s.points, ...points], curves: [...s.curves, ...curves], constraints: s.constraints };
  // Which side each copy is on, so it can't flip across its original later.
  const sides: number[] = [];
  for (let i = 0; i < ordered.length; i += 2) sides.push(offsetSide(drafted, ordered[i], ordered[i + 1]));
  constraints.push({ ...con("offset", ordered, distanceText), extra: sides, labelOffset: { x: 0, y: 0 } });
  const result = settle({ points: [...s.points, ...points], curves: [...s.curves, ...curves], constraints: [...s.constraints, ...constraints] });
  return { ...result, curveIds: curves.map((c) => c.id) };
}

/** Which side of its original an offset copy is: a line to the left (+1) or right (−1) of the original's direction; an arc or circle bigger (+1) or smaller (−1). */
export function offsetSide(s: SketchData, copyId: string, origId: string): number {
  const copy = curveById(s, copyId);
  const orig = curveById(s, origId);
  if (copy?.type === "line" && orig?.type === "line") {
    const a = pointPos(s, orig.p1);
    return Math.sign(cross(sub(pointPos(s, orig.p2), a), sub(pointPos(s, copy.p1), a))) || 1;
  }
  if ((copy?.type === "arc" || copy?.type === "circle") && (orig?.type === "arc" || orig?.type === "circle")) return Math.sign(radiusOf(s, copy) - radiusOf(s, orig)) || 1;
  return 1;
}

// ---------------------------------------------------------------------------
// Using a part's edge in a sketch

/**
 * Copy a part's edge into the sketch (Onshape's "Use"): straight edges and
 * circles or arcs lying flat on (or parallel to) the sketch plane. The copy is
 * fixed in place, ready to extrude, cut or dimension from.
 */
export function copyEdge(s: SketchData, frame: PlaneFrame, ref: EdgeRef): EditResult & { curveIds: string[] } {
  const fail = (error: string) => ({ sketch: s, curveIds: [], error });
  const height = (p: Vec3) => (p[0] - frame.origin[0]) * frame.n[0] + (p[1] - frame.origin[1]) * frame.n[1] + (p[2] - frame.origin[2]) * frame.n[2];
  const flat = Math.max(Math.abs(height(ref.a) - height(ref.mid)), Math.abs(height(ref.b) - height(ref.mid))) < 1e-4;
  if (!flat) return fail("That edge isn't flat to this sketch, so it can't be copied in. Pick an edge parallel to the sketch.");
  const A = toSketch(frame, ref.a);
  const B = toSketch(frame, ref.b);
  const M = toSketch(frame, ref.mid);
  const fixed = (id: string, p: P2): SketchConstraint => ({ id: sketchId("c"), type: "fix", refs: [id], extra: [p[0], p[1]] });
  const pt = (p: P2): SketchPoint => ({ id: sketchId("p"), x: p[0], y: p[1] });

  if (ref.curve === "LINE") {
    if (len(sub(A, B)) < 1e-6) return fail("That edge is end-on to the sketch, so it would be just a point.");
    const [pa, pb] = [pt(A), pt(B)];
    const id = sketchId("l");
    return {
      ...settle({
        points: [...s.points, pa, pb],
        curves: [...s.curves, { id, type: "line", p1: pa.id, p2: pb.id, construction: false }],
        constraints: [...s.constraints, fixed(pa.id, A), fixed(pb.id, B)],
      }),
      curveIds: [id],
    };
  }
  if (ref.curve === "CIRCLE") {
    const full = len(sub(A, B)) < 1e-6;
    // A whole circle's middle point is opposite its start; an arc's three points fix it.
    const centre: P2 | null = full ? mul(add(A, M), 0.5) : (() => {
      const ax = A[0], ay = A[1], bx = M[0], by = M[1], cx = B[0], cy = B[1];
      const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(d) < 1e-12) return null;
      const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
      const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
      return [ux, uy] as P2;
    })();
    if (!centre) return fail("Couldn't work out that arc's centre.");
    const r = len(sub(A, centre));
    if (r < 1e-6) return fail("That circle is end-on to the sketch.");
    const c = pt(centre);
    if (full) {
      const rim = pt(add(centre, [r, 0]));
      const id = sketchId("k");
      return {
        ...settle({
          points: [...s.points, c, rim],
          curves: [...s.curves, { id, type: "circle", center: c.id, radius: r, construction: false }],
          constraints: [...s.constraints, fixed(c.id, centre), fixed(rim.id, [rim.x, rim.y]), { id: sketchId("c"), type: "pointOnCircle", refs: [rim.id, id] }],
        }),
        curveIds: [id],
      };
    }
    // Arcs run anticlockwise from start to end: pick the order that passes through the middle point.
    const ang = (p: P2) => norm(Math.atan2(p[1] - centre[1], p[0] - centre[0]));
    const anticlockwise = norm(ang(M) - ang(A)) < norm(ang(B) - ang(A));
    const [ps, pe] = anticlockwise ? [pt(A), pt(B)] : [pt(B), pt(A)];
    const id = sketchId("a");
    return {
      ...settle({
        points: [...s.points, c, ps, pe],
        curves: [...s.curves, { id, type: "arc", center: c.id, start: ps.id, end: pe.id, construction: false }],
        constraints: [...s.constraints, fixed(c.id, centre), fixed(ps.id, [ps.x, ps.y]), fixed(pe.id, [pe.x, pe.y])],
      }),
      curveIds: [id],
    };
  }
  return fail("Only straight edges, circles and arcs can be copied into a sketch for now.");
}

// ---------------------------------------------------------------------------
// Mirror

/**
 * Mirror lines, arcs and circles across a line, like Onshape's sketch
 * Mirror. The copies are tied to the originals (each copied point is held
 * symmetric to its original across the line; circles keep the same size), so
 * they follow when the originals change. Points lying on the mirror line are
 * shared rather than copied, so a mirrored outline joins up.
 */
export function mirrorCurves(s: SketchData, axisId: string, curveIds: string[]): EditResult & { curveIds: string[] } {
  const fail = (error: string) => ({ sketch: s, error, curveIds: [] });
  const axis = curveById(s, axisId);
  if (axis?.type !== "line") return fail("Click a straight line to mirror about.");
  const [ax, ay] = pointPos(s, axis.p1);
  const [bx, by] = pointPos(s, axis.p2);
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1e-9) return fail("The mirror line has no length.");
  const sources = curveIds.map((id) => curveById(s, id)).filter((c): c is SketchCurve => !!c && c.id !== axisId);
  if (!sources.length) return fail("Click the lines, arcs or circles to mirror (not the mirror line itself).");

  const size = Math.max(len, ...s.points.map((p) => Math.hypot(p.x, p.y)), 1);
  const onAxis = (id: string) => {
    const [x, y] = pointPos(s, id);
    return Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / len < 1e-7 * size;
  };
  const points: SketchPoint[] = [];
  const constraints: SketchConstraint[] = [];
  const copies = new Map<string, string>();
  const copyOf = (id: string): string => {
    if (id === axis.p1 || id === axis.p2 || onAxis(id)) return id;
    const known = copies.get(id);
    if (known) return known;
    const [x, y] = mirrorPoint(s, axis, pointPos(s, id));
    const nid = sketchId("p");
    points.push({ id: nid, x, y });
    constraints.push({ id: sketchId("c"), type: "symmetric", refs: [id, nid, axisId] });
    copies.set(id, nid);
    return nid;
  };

  const curves: SketchCurve[] = [];
  for (const c of sources) {
    if (c.type === "line") {
      curves.push({ id: sketchId("l"), type: "line", p1: copyOf(c.p1), p2: copyOf(c.p2), construction: c.construction });
    } else if (c.type === "circle") {
      const id = sketchId("ci");
      curves.push({ id, type: "circle", center: copyOf(c.center), radius: c.radius, construction: c.construction });
      constraints.push({ id: sketchId("c"), type: "equal", refs: [c.id, id] });
    } else if (c.type === "spline") {
      const ids = c.points.map(copyOf);
      const tangents = movedHandles(s, c, ids, (p) => mirrorPoint(s, axis, p));
      const tangentsIn = movedHandles(s, c, ids, (p) => mirrorPoint(s, axis, p), "tangentsIn");
      curves.push({
        id: sketchId("sp"),
        type: "spline",
        points: ids,
        closed: c.closed,
        construction: c.construction,
        ...(c.conic !== undefined ? { conic: c.conic } : {}),
        ...(tangents ? { tangents } : {}),
        ...(tangentsIn ? { tangentsIn } : {}),
      });
    } else if (c.type === "ellipse") {
      // Part of an ellipse runs the other way round in the mirror, like an arc.
      const ends = c.start && c.end ? { start: copyOf(c.end), end: copyOf(c.start) } : {};
      curves.push({ id: sketchId("el"), type: "ellipse", center: copyOf(c.center), major: copyOf(c.major), minor: copyOf(c.minor), construction: c.construction, ...ends });
    } else {
      // A mirror image runs the other way round, so its start and end swap.
      curves.push({ id: sketchId("a"), type: "arc", center: copyOf(c.center), start: copyOf(c.end), end: copyOf(c.start), construction: c.construction });
    }
  }
  // A line mirrored onto itself (square to the mirror line, its ends both copied to each other) would double up.
  const unique = curves.filter(
    (c) => !(c.type === "line" && s.curves.some((o) => o.type === "line" && ((o.p1 === c.p1 && o.p2 === c.p2) || (o.p1 === c.p2 && o.p2 === c.p1)))),
  );
  if (!unique.length) return fail("Those are already their own mirror image.");
  const next: SketchData = { points: [...s.points, ...points], curves: [...s.curves, ...unique], constraints: [...s.constraints, ...constraints] };
  const r = solveSketch(next);
  if (!r.ok) return fail("The mirrored copy would conflict with the sketch's other constraints or dimensions.");
  return { sketch: r.sketch, curveIds: unique.map((c) => c.id) };
}

// ---------------------------------------------------------------------------
// Centre-point rectangle

/**
 * A rectangle drawn out from its centre: the centre point sits halfway along a
 * construction diagonal, so it stays in the middle when the rectangle is resized.
 */
export function addCentreRectangle(s: SketchData, centre: Placed, corner: Placed, construction = false): EditResult & { lineIds: string[] } {
  const opposite: Placed = { x: 2 * centre.x - corner.x, y: 2 * centre.y - corner.y, snap: null };
  const r = addRectangle(s, opposite, corner, construction);
  if (r.error) return { sketch: s, lineIds: [], error: "Move the pointer away from the centre to give the rectangle a width and height." };
  const first = curveById(r.sketch, r.lineIds[0]) as SketchLine;
  const second = curveById(r.sketch, r.lineIds[1]) as SketchLine;
  const atOrigin = centre.snap?.kind === "origin" || (centre.snap?.kind === "point" && centre.snap.id === ORIGIN_ID);
  const c = atOrigin ? { sketch: r.sketch, id: ORIGIN_ID } : placePoint(r.sketch, centre);
  const isNew = !r.sketch.points.some((p) => p.id === c.id);
  const sk = c.sketch;
  const diagonal = sketchId("l");
  return {
    ...settle({
      points: sk.points.map((p) => (isNew && p.id === c.id ? { ...p, standalone: true } : p)),
      curves: [...sk.curves, { id: diagonal, type: "line", p1: first.p1, p2: second.p2, construction: true }],
      constraints: [...sk.constraints, con("midpoint", [c.id, diagonal])],
    }),
    lineIds: r.lineIds,
  };
}

// ---------------------------------------------------------------------------
// Tangent arc

/**
 * Which way a line or arc is heading as it leaves the point `pointId` at one
 * of its ends (so a tangent arc can carry on smoothly), or null if no line or
 * arc ends there. The most recently drawn one wins.
 */
export function tangentAt(s: SketchData, pointId: string): { dir: P2; curveId: string } | null {
  for (const c of [...s.curves].reverse()) {
    if (c.type === "line" && (c.p1 === pointId || c.p2 === pointId)) {
      const p = pointPos(s, pointId);
      const o = pointPos(s, c.p1 === pointId ? c.p2 : c.p1);
      if (len(sub(p, o)) < 1e-9) continue;
      return { dir: unit(sub(p, o)), curveId: c.id };
    }
    if (c.type === "arc" && (c.start === pointId || c.end === pointId)) {
      const r = sub(pointPos(s, pointId), pointPos(s, c.center));
      // Arcs run anticlockwise from start to end.
      const dir: P2 = c.end === pointId ? [-r[1], r[0]] : [r[1], -r[0]];
      if (len(dir) < 1e-9) continue;
      return { dir: unit(dir), curveId: c.id };
    }
  }
  return null;
}

/** Centre of the arc leaving `start` heading along `dir` and ending at `end` (null if `end` is straight ahead). */
export function tangentArcCentre(start: P2, dir: P2, end: P2): P2 | null {
  const d = sub(end, start);
  const n: P2 = [-dir[1], dir[0]];
  const nd = dot(n, d);
  if (len(d) < 1e-9 || Math.abs(nd) < 1e-6 * len(d)) return null;
  return add(start, mul(n, dot(d, d) / (2 * nd)));
}

/** An arc that carries on smoothly from the end of a line or arc at `startId`, finishing at `end`. */
export function addTangentArc(s: SketchData, startId: string, end: Placed, construction = false): EditResult & { arcId: string } {
  const fail = (error: string) => ({ sketch: s, arcId: "", error });
  const t = tangentAt(s, startId);
  if (!t) return fail("Start a tangent arc at the end of a line or arc.");
  const P = pointPos(s, startId);
  const centre = tangentArcCentre(P, t.dir, [end.x, end.y]);
  if (!centre) return fail("That's straight ahead — move the pointer to one side to bend the arc.");
  const pe = placePoint(s, end);
  if (pe.id === startId) return fail("An arc needs two different ends.");
  const cid = sketchId("p");
  const anticlockwise = cross(t.dir, sub([end.x, end.y], P)) > 0;
  const id = sketchId("a");
  const arc: SketchArc = { id, type: "arc", center: cid, start: anticlockwise ? startId : pe.id, end: anticlockwise ? pe.id : startId, construction };
  const from = curveById(s, t.curveId)!;
  const tangent: SketchConstraint = con("tangent", [from.id, id]);
  if (from.type === "arc") {
    // Both centres on the same side of the joint: one arc sits inside the other.
    const internal = dot(sub(pointPos(s, from.center), P), sub(centre, P)) > 0;
    tangent.extra = [internal ? 1 : 0];
  }
  const sk = pe.sketch;
  return {
    ...settle({ points: [...sk.points, { id: cid, x: centre[0], y: centre[1] }], curves: [...sk.curves, arc], constraints: [...sk.constraints, tangent] }),
    arcId: id,
  };
}

// ---------------------------------------------------------------------------
// Sketch patterns

export type SketchPatternOptions =
  /**
   * `count` copies in a row (including the original), `spacing` mm apart, heading `angle` degrees from the X direction —
   * or along the line `lineId` (the other way if `reverse`), following it if it turns.
   */
  | { kind: "linear"; count: number; spacing: number; angle: number; lineId?: string; reverse?: boolean }
  /** `count` copies (including the original) spread over `angle` degrees around `centre` (360 = all the way round). */
  | { kind: "circular"; count: number; angle: number; centre: P2; centreId?: string };

/** Where each copy of a point goes: copy i (1 … count-1). */
export function patternTransform(opts: SketchPatternOptions, i: number): (p: P2) => P2 {
  if (opts.kind === "linear") {
    const a = (opts.angle * Math.PI) / 180;
    const off: P2 = [Math.cos(a) * opts.spacing * i, Math.sin(a) * opts.spacing * i];
    return (p) => add(p, off);
  }
  const full = Math.abs(Math.abs(opts.angle) - 360) < 1e-9;
  const step = full ? opts.angle / opts.count : opts.angle / Math.max(1, opts.count - 1);
  const t = (step * i * Math.PI) / 180;
  const c = Math.cos(t);
  const sn = Math.sin(t);
  const C = opts.centre;
  return (p) => {
    const [x, y] = sub(p, C);
    return add(C, [x * c - y * sn, x * sn + y * c]);
  };
}

/** Copy lines, arcs and circles in a row or around a centre (Onshape's sketch linear / circular pattern). */
export function patternCurves(s: SketchData, curveIds: string[], opts: SketchPatternOptions): EditResult & { curveIds: string[] } {
  const fail = (error: string) => ({ sketch: s, error, curveIds: [] });
  const sources = curveIds.map((id) => curveById(s, id)).filter((c): c is SketchCurve => !!c);
  if (!sources.length) return fail("Click the lines, arcs and circles to repeat first.");
  const count = Math.round(opts.count);
  if (!(count >= 2 && count <= 200)) return fail("The number of copies must be between 2 and 200.");
  if (opts.kind === "linear" && !(Math.abs(opts.spacing) > 1e-9)) return fail("Give the copies some spacing.");
  if (opts.kind === "circular" && !(Math.abs(opts.angle) > 1e-9)) return fail("Give the pattern an angle to spread over.");
  const points: SketchPoint[] = [];
  const curves: SketchCurve[] = [];
  const constraints: SketchConstraint[] = [];
  const centreId = opts.kind === "circular" && opts.centreId && isPointId(s, opts.centreId) ? opts.centreId : null;
  const lineId = opts.kind === "linear" && opts.lineId && curveById(s, opts.lineId)?.type === "line" ? opts.lineId : null;
  for (let i = 1; i < count; i++) {
    const before = curves.length;
    const copies = copyCurvesWith(s, sources, patternTransform(opts, i), points, curves);
    if (opts.kind === "linear") {
      // In a row: each copy stays the original moved along (along the line, if one was picked), so the copies follow when the originals or the line move.
      const along = opts.spacing * i * (lineId && opts.reverse ? -1 : 1);
      for (const [from, to] of copies) constraints.push(con("patternMove", lineId ? [to, from, lineId] : [to, from], undefined, [along, opts.angle]));
    } else if (centreId) {
      // Round a point of the sketch: each copy stays turned round it, so the copies follow when the centre or the originals move.
      const turn = patternStep(opts) * i;
      for (const [from, to] of copies) constraints.push(con("patternCopy", [to, from, centreId], undefined, [turn]));
    } else continue;
    sources.forEach((c, k) => {
      const copy = curves[before + k];
      // The copy's size follows the original's (an equal marked as the pattern's, extra [1]).
      if (c.type === "circle" && copy?.type === "circle") constraints.push(con("equal", [copy.id, c.id], undefined, [1]));
    });
  }
  return { ...settle({ points: [...s.points, ...points], curves: [...s.curves, ...curves], constraints: [...s.constraints, ...constraints] }), curveIds: curves.map((c) => c.id) };
}

/** How far round each copy of a circular pattern turns from the one before (degrees). */
function patternStep(opts: Extract<SketchPatternOptions, { kind: "circular" }>): number {
  const full = Math.abs(Math.abs(opts.angle) - 360) < 1e-9;
  return full ? opts.angle / opts.count : opts.angle / Math.max(1, opts.count - 1);
}

/**
 * Copies of `sources` with every point moved by `move` (points that don't move are shared); added to `points` and `curves`.
 * Returns which point each new point is a copy of. Copies don't follow part edges (they aren't linked).
 */
function copyCurvesWith(s: SketchData, sources: SketchCurve[], move: (p: P2) => P2, points: SketchPoint[], curves: SketchCurve[]): Map<string, string> {
  {
    const copies = new Map<string, string>();
    const copyOf = (id: string): string => {
      const known = copies.get(id);
      if (known) return known;
      const at = pointPos(s, id);
      const to = move(at);
      // A point that doesn't move (the centre of a circular pattern) is shared.
      if (len(sub(to, at)) < 1e-9) return id;
      const nid = sketchId("p");
      points.push({ id: nid, x: to[0], y: to[1] });
      copies.set(id, nid);
      return nid;
    };
    for (const c of sources) {
      if (c.type === "line") curves.push({ id: sketchId("l"), type: "line", p1: copyOf(c.p1), p2: copyOf(c.p2), construction: c.construction });
      else if (c.type === "circle") curves.push({ id: sketchId("k"), type: "circle", center: copyOf(c.center), radius: c.radius, construction: c.construction });
      else if (c.type === "spline") {
        const ids = c.points.map(copyOf);
        const tangents = movedHandles(s, c, ids, move);
        const tangentsIn = movedHandles(s, c, ids, move, "tangentsIn");
        curves.push({
          id: sketchId("sp"),
          type: "spline",
          points: ids,
          closed: c.closed,
          construction: c.construction,
          ...(c.conic !== undefined ? { conic: c.conic } : {}),
          ...(tangents ? { tangents } : {}),
          ...(tangentsIn ? { tangentsIn } : {}),
        });
      } else if (c.type === "ellipse")
        curves.push({
          id: sketchId("el"),
          type: "ellipse",
          center: copyOf(c.center),
          major: copyOf(c.major),
          minor: copyOf(c.minor),
          construction: c.construction,
          ...(c.start && c.end ? { start: copyOf(c.start), end: copyOf(c.end) } : {}),
        });
      else curves.push({ id: sketchId("a"), type: "arc", center: copyOf(c.center), start: copyOf(c.start), end: copyOf(c.end), construction: c.construction });
    }
    return copies;
  }
}


/** A spline's handles carried along with a copy of it (moved, turned or mirrored the same way), keyed by the copied points' ids. */
function movedHandles(s: SketchData, c: SketchSpline, newIds: string[], move: (p: P2) => P2, which: "tangents" | "tangentsIn" = "tangents"): Record<string, P2> | undefined {
  const handles = c[which];
  if (!handles) return undefined;
  const out: Record<string, P2> = {};
  c.points.forEach((id, i) => {
    const t = handles[id];
    if (!t) return;
    const p = pointPos(s, id);
    const a = move(p);
    const b = move([p[0] + t[0], p[1] + t[1]]);
    out[newIds[i]] = [b[0] - a[0], b[1] - a[1]];
  });
  return Object.keys(out).length ? out : undefined;
}

/** Move / copy settings as numbers (mm and degrees). */
export interface SketchTransformOptions {
  dx: number;
  dy: number;
  angle: number;
  copy: boolean;
}

/** Where a point goes: turned by `angle` about the shapes' middle, then moved by (dx, dy). */
export function transformMove(s: SketchData, sources: SketchCurve[], t: Pick<SketchTransformOptions, "dx" | "dy" | "angle">): (p: P2) => P2 {
  const ids = [...new Set(sources.flatMap(curvePoints))];
  const pts = ids.map((id) => pointPos(s, id));
  const c: P2 = pts.length ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length] : [0, 0];
  const r = (t.angle * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return (p) => {
    const [x, y] = sub(p, c);
    return [c[0] + x * cos - y * sin + t.dx, c[1] + x * sin + y * cos + t.dy];
  };
}

/** Move (or copy) lines, arcs and circles by a distance and/or a turn. */
export function transformCurves(s: SketchData, curveIds: string[], t: SketchTransformOptions): EditResult & { curveIds: string[] } {
  const sources = curveIds.map((id) => curveById(s, id)).filter((c): c is SketchCurve => !!c);
  if (!sources.length) return { sketch: s, error: "Click the lines, arcs and circles to move first.", curveIds: [] };
  if (Math.abs(t.dx) < 1e-9 && Math.abs(t.dy) < 1e-9 && Math.abs(t.angle) < 1e-9) return { sketch: s, error: "Type how far to move or turn them.", curveIds: [] };
  const move = transformMove(s, sources, t);
  if (t.copy) {
    const points: SketchPoint[] = [];
    const curves: SketchCurve[] = [];
    copyCurvesWith(s, sources, move, points, curves);
    return { ...settle({ points: [...s.points, ...points], curves: [...s.curves, ...curves], constraints: s.constraints }), curveIds: curves.map((c) => c.id) };
  }
  const moving = new Set(sources.flatMap(curvePoints).filter((id) => id !== ORIGIN_ID));
  const points = s.points.map((p) => {
    if (!moving.has(p.id)) return p;
    const [x, y] = move([p.x, p.y]);
    return { ...p, x, y };
  });
  // Splines' handles turn with them.
  const curves = s.curves.map((c) => {
    if (c.type !== "spline" || !(c.tangents || c.tangentsIn) || !sources.includes(c)) return c;
    const tangents = movedHandles(s, c, c.points, move);
    const tangentsIn = movedHandles(s, c, c.points, move, "tangentsIn");
    return { ...c, ...(tangents ? { tangents } : {}), ...(tangentsIn ? { tangentsIn } : {}) };
  });
  const r = settle({ ...s, points, curves });
  // Constraints (a fix, a dimension to something that stays) may hold them where they were.
  const before = pointPos(s, [...moving][0]);
  const after = pointPos(r.sketch, [...moving][0]);
  const wanted = move(before);
  if (len(sub(after, wanted)) > 1e-3 && len(sub(after, before)) < 1e-3) {
    return { sketch: s, error: "They're held where they are by their constraints (a fix or a dimension) — remove those to move them.", curveIds: [] };
  }
  return { ...r, curveIds: sources.map((c) => c.id) };
}

/** The pattern tool's settings as typed (from the sketch panel). */
export interface PatternSettings {
  patternKind: "linear" | "circular";
  patternCount: number;
  patternSpacing: string;
  patternAngle: string;
  patternCentre: string;
  /** Linear: the line the direction was taken from (used while the angle still runs along it). */
  patternLine?: string;
}

/** Turn the typed pattern settings into numbers, or say what's wrong with them. */
export function readPatternSettings(s: SketchData, set: PatternSettings): SketchPatternOptions | string {
  const angle = evaluate(set.patternAngle);
  if (!angle.ok) return `Angle: ${angle.error}`;
  if (set.patternKind === "linear") {
    const spacing = evaluate(set.patternSpacing);
    if (!spacing.ok) return `Spacing: ${spacing.error}`;
    const line = set.patternLine ? curveById(s, set.patternLine) : undefined;
    if (line?.type === "line") {
      // Still along the picked line (or straight back along it)? Then the copies follow the line.
      const [a, b] = [pointPos(s, line.p1), pointPos(s, line.p2)];
      const lineAngle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      const off = (((angle.value - lineAngle) % 360) + 360) % 360;
      const near = (v: number) => Math.min(Math.abs(off - v), 360 - Math.abs(off - v)) < 0.01;
      if (near(0) || near(180)) return { kind: "linear", count: set.patternCount, spacing: spacing.value, angle: angle.value, lineId: line.id, reverse: near(180) };
    }
    return { kind: "linear", count: set.patternCount, spacing: spacing.value, angle: angle.value };
  }
  const known = set.patternCentre === ORIGIN_ID || s.points.some((p) => p.id === set.patternCentre);
  const centreId = known ? set.patternCentre : ORIGIN_ID;
  return { kind: "circular", count: set.patternCount, angle: angle.value, centre: pointPos(s, centreId), centreId };
}

// ---------------------------------------------------------------------------
// Spline

/** A smooth curve through the clicked points (closed: back round to the first). */
export function addSpline(s: SketchData, placed: Placed[], closed: boolean, construction = false): EditResult & { splineId: string } {
  const fail = (error: string) => ({ sketch: s, splineId: "", error });
  let sk = s;
  const ids: string[] = [];
  for (const p of placed) {
    const r = placePoint(sk, p);
    sk = r.sketch;
    if (ids[ids.length - 1] !== r.id) ids.push(r.id);
  }
  // Clicking the first point again closes it.
  if (ids.length > 2 && ids[0] === ids[ids.length - 1]) {
    ids.pop();
    closed = true;
  }
  if (ids.length < 2 || (closed && ids.length < 3)) return fail(closed ? "A closed spline needs at least three points." : "Click at least two points for a spline.");
  const id = sketchId("sp");
  const spline: SketchSpline = { id, type: "spline", points: ids, closed, construction };
  return { ...settle({ ...sk, curves: [...sk.curves, spline] }), splineId: id };
}

// ---------------------------------------------------------------------------
// Conic

/**
 * A conic from `start` to `end`, pulled towards the corner point `apex` by
 * `rho` (0.5 = a parabola; less is flatter, more is fuller).
 */
export function addConic(s: SketchData, start: Placed, end: Placed, apex: Placed, rho: number, construction = false): EditResult & { conicId: string } {
  const fail = (error: string) => ({ sketch: s, conicId: "", error });
  if (!(rho > 0 && rho < 1)) return fail("The conic's fullness must be between 0 and 1 (0.5 is a parabola).");
  let sk = s;
  const ids: string[] = [];
  for (const p of [start, apex, end]) {
    const r = placePoint(sk, p);
    sk = r.sketch;
    ids.push(r.id);
  }
  if (new Set(ids).size < 3) return fail("Click three different points: both ends, then the corner the curve bends towards.");
  const [a, m, b] = ids.map((id) => pointPos(sk, id));
  const cross = (m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0]);
  if (Math.abs(cross) < 1e-6 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 2)) return fail("The corner point is in line with the ends, so there's no bend. Click it off to one side.");
  const id = sketchId("cn");
  const conic: SketchSpline = { id, type: "spline", points: ids, closed: false, construction, conic: rho };
  return { ...settle({ ...sk, curves: [...sk.curves, conic] }), conicId: id };
}

/** Change a conic's fullness. */
export function setConicRho(s: SketchData, id: string, rho: number): SketchData {
  if (!(rho > 0 && rho < 1)) return s;
  return { ...s, curves: s.curves.map((c) => (c.id === id && c.type === "spline" && c.conic !== undefined ? { ...c, conic: rho } : c)) };
}

// ---------------------------------------------------------------------------
// Ellipse

/**
 * An ellipse from three clicks: its centre, the end of one axis, and how wide
 * it is the other way (the third click's distance from the first axis).
 */
export function addEllipse(s: SketchData, centre: Placed, major: Placed, side: P2, construction = false): EditResult & { ellipseId: string } {
  const fail = (error: string) => ({ sketch: s, ellipseId: "", error });
  const c: P2 = [centre.x, centre.y];
  const m: P2 = [major.x, major.y];
  const rx = len(sub(m, c));
  const minor = minorPointFor(c, m, side);
  if (rx < 1e-6 || len(sub(minor, c)) < 1e-6) return fail("Drag out the ellipse's length, then its width.");
  let sk = s;
  const a = placePoint(sk, centre);
  sk = a.sketch;
  const b = placePoint(sk, major);
  sk = b.sketch;
  if (a.id === b.id) return fail("Drag out the ellipse's length, then its width.");
  const mid = sketchId("p");
  const id = sketchId("el");
  const ellipse: SketchEllipse = { id, type: "ellipse", center: a.id, major: b.id, minor: mid, construction };
  return { ...settle({ ...sk, points: [...sk.points, { id: mid, x: minor[0], y: minor[1] }], curves: [...sk.curves, ellipse] }), ellipseId: id };
}

// ---------------------------------------------------------------------------
// More ways to draw circles, arcs and rectangles

const snappedPoint = (p: Placed): string | null => (p.snap?.kind === "point" ? p.snap.id : p.snap?.kind === "origin" ? ORIGIN_ID : null);

/** A circle through three clicked points (any clicked on existing points stay on the circle). */
export function addThreePointCircle(s: SketchData, a: Placed, b: Placed, c: Placed, construction = false): EditResult & { circleId: string } {
  const centre = circleThrough([a.x, a.y], [b.x, b.y], [c.x, c.y]);
  if (!centre) return { sketch: s, circleId: "", error: "Those three points are in a line — move the last one to make a circle." };
  const r = addCircle(s, { x: centre[0], y: centre[1], snap: null }, len(sub([a.x, a.y], centre)), construction);
  if (r.error) return r;
  const on = [a, b, c].map(snappedPoint).filter((id): id is string => !!id);
  if (!on.length) return r;
  const constraints = [...r.sketch.constraints, ...on.map((id) => con("pointOnCircle", [id, r.circleId]))];
  return { ...settle({ ...r.sketch, constraints }), circleId: r.circleId };
}

/** An arc from its centre, a start point and where it ends (the shorter way round from the start). */
export function addCentreArc(s: SketchData, centre: Placed, start: Placed, end: Placed, construction = false): EditResult & { arcId: string } {
  const c: P2 = [centre.x, centre.y];
  const r = len(sub([start.x, start.y], c));
  const towards = sub([end.x, end.y], c);
  if (r < 1e-6 || len(towards) < 1e-6) return { sketch: s, arcId: "", error: "Click the centre, then where the arc starts, then where it ends." };
  const a0 = Math.atan2(start.y - c[1], start.x - c[0]);
  let sweep = Math.atan2(towards[1], towards[0]) - a0;
  while (sweep > Math.PI) sweep -= TAU;
  while (sweep <= -Math.PI) sweep += TAU;
  if (Math.abs(sweep) < 1e-6) return { sketch: s, arcId: "", error: "Move round from the start to make the arc." };
  const at = (ang: number): Placed => ({ x: c[0] + r * Math.cos(ang), y: c[1] + r * Math.sin(ang), snap: null });
  const endPoint: Placed = end.snap?.kind === "point" && Math.abs(len(towards) - r) < 1e-6 ? end : at(a0 + sweep);
  const made = addArc(s, start, endPoint, at(a0 + sweep / 2), construction);
  if (made.error) return made;
  const id = snappedPoint(centre);
  if (!id) return made;
  const arc = made.sketch.curves.find((x) => x.id === made.arcId);
  if (arc?.type !== "arc") return made;
  return { ...settle({ ...made.sketch, constraints: [...made.sketch.constraints, con("coincident", [arc.center, id])] }), arcId: made.arcId };
}

/** Where a rectangle on edge a–b reaches across to, for a third click at `p`: how far from that edge (signed). */
export function alignedWidth(a: P2, b: P2, p: P2): number {
  const d = unit(sub(b, a));
  return cross(d, sub(p, a));
}

/** A rectangle at any angle: two clicks for one side, a third for how wide it is. */
export function addAlignedRectangle(s: SketchData, a: Placed, b: Placed, p: P2, construction = false): EditResult & { lineIds: string[] } {
  const A: P2 = [a.x, a.y];
  const B: P2 = [b.x, b.y];
  const d = unit(sub(B, A));
  const w = alignedWidth(A, B, p);
  if (len(sub(B, A)) < 1e-6 || Math.abs(w) < 1e-6) return { sketch: s, lineIds: [], error: "Click two corners along one side, then move out to set the width." };
  const n: P2 = [-d[1] * w, d[0] * w];
  const pa = placePoint(s, a);
  const pb = placePoint(pa.sketch, b);
  if (pa.id === pb.id) return { sketch: s, lineIds: [], error: "Click two different corners." };
  const c3 = sketchId("p");
  const c4 = sketchId("p");
  const C = add(B, n);
  const D = add(A, n);
  let sk: SketchData = { ...pb.sketch, points: [...pb.sketch.points, { id: c3, x: C[0], y: C[1] }, { id: c4, x: D[0], y: D[1] }] };
  const corners = [pa.id, pb.id, c3, c4];
  const lineIds = corners.map(() => sketchId("l"));
  const lines: SketchLine[] = corners.map((q, i) => ({ id: lineIds[i], type: "line", p1: q, p2: corners[(i + 1) % 4], construction }));
  const constraints = [con("parallel", [lineIds[0], lineIds[2]]), con("parallel", [lineIds[1], lineIds[3]]), con("perpendicular", [lineIds[0], lineIds[1]])];
  sk = { ...sk, curves: [...sk.curves, ...lines], constraints: [...sk.constraints, ...constraints] };
  return { ...settle(sk), lineIds };
}

// ---------------------------------------------------------------------------
// Extend and split

/**
 * Extend a line from the end nearest the click until it meets another line,
 * arc or circle (the nearest one ahead). Its length dimension, if any, goes,
 * since the length changes; the end is held on what it now meets.
 */
export function extendAt(s: SketchData, curveId: string, at: { x: number; y: number }): EditResult {
  const line = curveById(s, curveId);
  if (line?.type === "arc") return extendArc(s, line, at);
  if (line?.type !== "line") return { sketch: s, error: "Click near the end of a line or arc to extend it." };
  const A = pointPos(s, line.p1);
  const B = pointPos(s, line.p2);
  const click: P2 = [at.x, at.y];
  const fromEnd = len(sub(click, B)) <= len(sub(click, A));
  const [start, end, endId] = fromEnd ? [A, B, line.p2] : [B, A, line.p1];
  const dir = unit(sub(end, start));
  if (len(sub(end, start)) < 1e-9) return { sketch: s, error: "That line has no length." };
  // The nearest crossing ahead of the end, along the line carried on.
  let best: { t: number; point: P2; by: string } | null = null;
  const consider = (t: number, point: P2, by: string) => {
    if (t > 1e-6 && (!best || t < best.t)) best = { t, point, by };
  };
  for (const other of s.curves) {
    if (other.id === line.id) continue;
    if (other.type === "line") {
      const C = pointPos(s, other.p1);
      const D = pointPos(s, other.p2);
      const e = sub(D, C);
      const den = cross(dir, e);
      if (Math.abs(den) < 1e-12) continue;
      const w = sub(C, end);
      const t = cross(w, e) / den;
      const u = cross(w, dir) / den;
      if (u >= -1e-9 && u <= 1 + 1e-9) consider(t, add(end, mul(dir, t)), other.id);
    } else if (other.type === "circle" || other.type === "arc") {
      const { c, r } = circleOf(s, other);
      const f = sub(end, c);
      const b = dot(f, dir);
      const disc = b * b - (dot(f, f) - r * r);
      if (disc < 0) continue;
      for (const t of [-b - Math.sqrt(disc), -b + Math.sqrt(disc)]) {
        const p = add(end, mul(dir, t));
        if (other.type === "circle" || onArc(s, other, p)) consider(t, p, other.id);
      }
    } else {
      // A spline or ellipse: along its short straight pieces.
      const path = other.type === "spline" ? splinePath(s, other, 48) : ellipsePoints(s, other, 1024);
      for (let i = 0; i + 1 < path.length; i++) {
        const e = sub(path[i + 1], path[i]);
        const den = cross(dir, e);
        if (Math.abs(den) < 1e-12) continue;
        const w = sub(path[i], end);
        const t = cross(w, e) / den;
        const u = cross(w, dir) / den;
        if (u >= -1e-9 && u <= 1 + 1e-9) consider(t, add(end, mul(dir, t)), other.id);
      }
    }
  }
  const hit = best as { t: number; point: P2; by: string } | null;
  if (!hit) return { sketch: s, error: "There's nothing ahead of that end for the line to reach." };
  const target = curveById(s, hit.by)!;
  const points = s.points.map((p) => (p.id === endId ? { ...p, x: hit.point[0], y: hit.point[1] } : p));
  const constraints = s.constraints
    .filter((c) => !(c.type === "length" && c.refs[0] === line.id))
    .concat([con(onCurveType(target), [endId, target.id])]);
  return settle({ ...s, points, constraints });
}

/**
 * Extend an arc round its circle, from the end nearest the click, until it
 * meets another line, arc, circle, spline or ellipse.
 */
function extendArc(s: SketchData, arc: SketchArc, at: { x: number; y: number }): EditResult {
  const C = pointPos(s, arc.center);
  const r = radiusOf(s, arc);
  const S = pointPos(s, arc.start);
  const E = pointPos(s, arc.end);
  const click: P2 = [at.x, at.y];
  const fromEnd = len(sub(click, E)) <= len(sub(click, S));
  const endId = fromEnd ? arc.end : arc.start;
  const ang = (p: P2) => Math.atan2(p[1] - C[1], p[0] - C[0]);
  const [a0, sweep] = arcSpan(s, arc);
  // How far round (radians) a point is past the end being extended: anticlockwise past the end, clockwise before the start.
  const ahead = (p: P2) => (fromEnd ? norm(ang(p) - (a0 + sweep)) : norm(a0 - ang(p)));
  const whole: SketchCircle = { id: arc.id, type: "circle", center: arc.center, radius: r, construction: arc.construction };
  let best: { t: number; point: P2; by: string } | null = null;
  for (const other of s.curves) {
    if (other.id === arc.id) continue;
    for (const p of intersections(s, whole, other)) {
      const t = ahead(p);
      // Not the end itself, and not so far round it would meet its own other end.
      if (t > 1e-6 && t < TAU - sweep - 1e-6 && (!best || t < best.t)) best = { t, point: p, by: other.id };
    }
  }
  const hit = best as { t: number; point: P2; by: string } | null;
  if (!hit) return { sketch: s, error: "There's nothing further round that arc for it to reach." };
  const target = curveById(s, hit.by)!;
  const points = s.points.map((p) => (p.id === endId ? { ...p, x: hit.point[0], y: hit.point[1] } : p));
  const on = [con(onCurveType(target), [endId, target.id])];
  // Its length and angle change as it grows (like a line's length when a line is extended).
  const kept = s.constraints.filter((c) => !((c.type === "arcLength" || c.type === "arcAngle") && c.refs[0] === arc.id));
  const solved = solveSketch({ ...s, points, constraints: [...kept, ...on] });
  if (!solved.ok) return { sketch: s, error: "That arc's end is held where it is by its constraints, so it can't be extended." };
  return { sketch: solved.sketch };
}

/** Split an arc in two where it's clicked; both pieces keep the same centre and size. */
function splitArc(s: SketchData, arc: SketchArc, at: { x: number; y: number }): EditResult & { lineIds: string[] } {
  const C = pointPos(s, arc.center);
  const r = radiusOf(s, arc);
  const [a0, sweep] = arcSpan(s, arc);
  const t = norm(Math.atan2(at.y - C[1], at.x - C[0]) - a0);
  if (t <= sweep * 0.02 || t >= sweep * 0.98) return { sketch: s, lineIds: [], error: "Click further from the arc's ends to split it." };
  const pid = sketchId("p");
  const second = sketchId("a");
  const first: SketchArc = { ...arc, end: pid };
  const rest: SketchArc = { id: second, type: "arc", center: arc.center, start: pid, end: arc.end, construction: arc.construction };
  const constraints: SketchConstraint[] = [];
  for (const c of s.constraints) {
    if (!c.refs.includes(arc.id)) {
      constraints.push(c);
      continue;
    }
    // Halfway round the whole arc, or how long or far round the whole arc is, means nothing for either piece.
    if (c.type === "midpoint" || c.type === "arcLength" || c.type === "arcAngle") continue;
    // Something joined smoothly onto the arc's far end now joins the second piece.
    if (c.type === "tangent") {
      const other = curveById(s, c.refs.find((x) => x !== arc.id)!);
      const ends = other ? (other.type === "line" ? [other.p1, other.p2] : other.type === "arc" ? [other.start, other.end] : []) : [];
      if (ends.includes(arc.end) && !ends.includes(arc.start)) {
        constraints.push({ ...c, refs: c.refs.map((x) => (x === arc.id ? second : x)) });
        continue;
      }
    }
    constraints.push(c);
  }
  const point = { id: pid, x: C[0] + r * Math.cos(a0 + t), y: C[1] + r * Math.sin(a0 + t) };
  const curves = s.curves.flatMap((c) => (c.id === arc.id ? [first, rest] : [c]));
  return { ...settle({ points: [...s.points, point], curves, constraints }), lineIds: [arc.id, second] };
}

/** Split a line (or arc) in two where it's clicked; the two halves stay in line with each other (or on the same circle). */
export function splitAt(s: SketchData, curveId: string, at: { x: number; y: number }): EditResult & { lineIds: string[] } {
  const line = curveById(s, curveId);
  if (line?.type === "arc") return splitArc(s, line, at);
  if (line?.type === "circle") return { sketch: s, lineIds: [], error: "A circle has no ends to split between — use Trim to cut a piece out of it, or draw an arc instead." };
  if (isWavy(line)) return splitWavy(s, line, at);
  if (line?.type !== "line") return { sketch: s, lineIds: [], error: "Click a line, arc, spline or ellipse where you want to split it." };
  const A = pointPos(s, line.p1);
  const B = pointPos(s, line.p2);
  const d = sub(B, A);
  const t = dot(sub([at.x, at.y], A), d) / (dot(d, d) || 1);
  if (t <= 0.02 || t >= 0.98) return { sketch: s, lineIds: [], error: "Click further from the line's ends to split it." };
  const mid: P2 = add(A, mul(d, t));
  const pid = sketchId("p");
  const second = sketchId("l");
  const first: SketchLine = { ...line, p2: pid };
  const rest: SketchLine = { id: second, type: "line", p1: pid, p2: line.p2, construction: line.construction };
  // Relations on the whole line carry on to both halves; its length goes (each half has its own now).
  const extra: SketchConstraint[] = [con("parallel", [line.id, second])];
  const constraints: SketchConstraint[] = [];
  for (const c of s.constraints) {
    if (c.type === "length" && c.refs[0] === line.id) continue;
    // Something that was on the far end now belongs to the second half.
    if ((c.type === "horizontal" || c.type === "vertical") && c.refs.length === 1 && c.refs[0] === line.id) extra.push(con(c.type, [second]));
    constraints.push(c);
  }
  const points = [...s.points, { id: pid, x: mid[0], y: mid[1] }];
  const curves = s.curves.flatMap((c) => (c.id === line.id ? [first, rest] : [c]));
  return { ...settle({ points, curves, constraints: [...constraints, ...extra] }), lineIds: [line.id, second] };
}

/** The move / copy tool's settings as typed (from the sketch panel), as numbers — or what's wrong with them. */
export function readTransformSettings(set: { moveDx: string; moveDy: string; moveAngle: string; moveCopy: boolean }): SketchTransformOptions | string {
  const dx = evaluate(set.moveDx || "0");
  if (!dx.ok) return `Across: ${dx.error}`;
  const dy = evaluate(set.moveDy || "0");
  if (!dy.ok) return `Up: ${dy.error}`;
  const angle = evaluate(set.moveAngle || "0");
  if (!angle.ok) return `Turn: ${angle.error}`;
  return { dx: dx.value, dy: dy.value, angle: angle.value, copy: set.moveCopy };
}
