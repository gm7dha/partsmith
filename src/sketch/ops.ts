/**
 * Editing operations on a sketch. Each takes a sketch and returns a new one
 * (never modifying the input), already solved so every constraint holds.
 * When an edit can't be satisfied it returns an `error` in plain English and
 * the caller keeps the old sketch.
 */
import { evaluate } from "../model/expr";
import { ellipseAt as ellipseAtParam, ellipseFrom, ellipsePolyline, type EllipseGeom } from "./ellipse";
import { splinePolyline, splineTangents } from "./spline";
import { curveParam, ellipseSpan, nearestParam } from "./curves";
import { startingLength } from "../model/units";
import { analyzeSketch, solveSketch } from "./solver";
import { linkEdge, type RefEdge } from "./links";
import {
  isAngleDimension,
  isDimension,
  ORIGIN_ID,
  type ConstraintType,
  type RelationType,
  type SketchArc,
  type SketchCircle,
  type SketchConstraint,
  type SketchCurve,
  type SketchData,
  type SketchLine,
  type SketchEllipse,
  type SketchSpline,
} from "./types";

let counter = 0;
export function sketchId(prefix: string): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** What a click landed on, so new geometry can attach to it. */
export type Snap =
  | { kind: "point"; id: string }
  | { kind: "origin" }
  | { kind: "curve"; id: string }
  /** Lined up with earlier points: straight above/below point `x` (same x), and/or level with point `y` (same y). */
  | { kind: "align"; x?: string; y?: string }
  /** The middle of a line (held there with a Midpoint constraint). */
  | { kind: "midpoint"; id: string }
  /**
   * On a part edge shown in the sketch: at one of its ends, its centre, its
   * middle, or anywhere along it. The edge is brought in (as a reference that
   * follows the part) when the point is placed.
   */
  | { kind: "ref"; edge: RefEdge; at: "a" | "b" | "centre" | "mid" | "on" };

export interface Placed {
  x: number;
  y: number;
  snap?: Snap | null;
}

export interface EditResult {
  sketch: SketchData;
  error?: string;
}

// ---------------------------------------------------------------------------
// Lookups and measurements

export function pointPos(s: SketchData, id: string): [number, number] {
  if (id === ORIGIN_ID) return [0, 0];
  const p = s.points.find((q) => q.id === id);
  if (!p) throw new Error(`missing point ${id}`);
  return [p.x, p.y];
}

export const curveById = (s: SketchData, id: string) => s.curves.find((c) => c.id === id);
export const isPointId = (s: SketchData, id: string) => id === ORIGIN_ID || s.points.some((p) => p.id === id);

export function radiusOf(s: SketchData, c: SketchCircle | SketchArc): number {
  if (c.type === "circle") return c.radius;
  const [cx, cy] = pointPos(s, c.center);
  const [sx, sy] = pointPos(s, c.start);
  return Math.hypot(sx - cx, sy - cy);
}

/** How far round an arc goes, anticlockwise from its start to its end (radians, more than 0 and at most 2π). */
export function arcSweep(s: SketchData, c: SketchArc): number {
  const [cx, cy] = pointPos(s, c.center);
  const [sx, sy] = pointPos(s, c.start);
  const [ex, ey] = pointPos(s, c.end);
  let sweep = Math.atan2(ey - cy, ex - cx) - Math.atan2(sy - cy, sx - cx);
  while (sweep <= 0) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  return sweep;
}

/** An ellipse's centre, half-lengths and turn. */
export function ellipseGeom(s: SketchData, c: SketchEllipse): EllipseGeom {
  return ellipseFrom(pointPos(s, c.center), pointPos(s, c.major), pointPos(s, c.minor));
}

/** Points that define a curve (moving these moves the curve). */
export function curvePoints(c: SketchCurve): string[] {
  return c.type === "line"
    ? [c.p1, c.p2]
    : c.type === "circle"
      ? [c.center]
      : c.type === "spline"
        ? [...c.points]
        : c.type === "ellipse"
          ? [c.center, c.major, c.minor, ...(c.start && c.end ? [c.start, c.end] : [])]
          : [c.center, c.start, c.end];
}

function lineDir(s: SketchData, l: SketchLine): [number, number] {
  const [ax, ay] = pointPos(s, l.p1);
  const [bx, by] = pointPos(s, l.p2);
  return [bx - ax, by - ay];
}

/** The value a dimension currently measures (mm, or degrees for angles). */
export function measure(s: SketchData, c: SketchConstraint): number {
  const [a, b] = c.refs;
  switch (c.type) {
    case "distance": {
      const [px, py] = pointPos(s, a);
      const [qx, qy] = pointPos(s, b);
      return Math.hypot(qx - px, qy - py);
    }
    case "length": {
      const [dx, dy] = lineDir(s, curveById(s, a) as SketchLine);
      return Math.hypot(dx, dy);
    }
    case "horizontalDistance":
    case "verticalDistance": {
      const k = c.type === "horizontalDistance" ? 0 : 1;
      return Math.abs(pointPos(s, b)[k] - pointPos(s, a)[k]);
    }
    case "radius":
      return radiusOf(s, curveById(s, a) as SketchCircle | SketchArc);
    case "diameter":
      return 2 * radiusOf(s, curveById(s, a) as SketchCircle | SketchArc);
    case "angle": {
      const { u, w } = angleRays(s, c);
      return Math.abs((Math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1]) * 180) / Math.PI);
    }
    case "pointLineDistance": {
      const [px, py] = pointPos(s, a);
      const l = curveById(s, b) as SketchLine;
      const [ax, ay] = pointPos(s, l.p1);
      const [dx, dy] = lineDir(s, l);
      return Math.abs(dx * (py - ay) - dy * (px - ax)) / (Math.hypot(dx, dy) || 1);
    }
    case "offset": {
      // The first pair: how far the copy is from the original.
      const copy = curveById(s, a);
      const orig = curveById(s, b);
      if (copy?.type === "line" && orig?.type === "line") return measure(s, { id: "", type: "pointLineDistance", refs: [copy.p1, orig.id] });
      if ((copy?.type === "arc" || copy?.type === "circle") && (orig?.type === "arc" || orig?.type === "circle")) return Math.abs(radiusOf(s, copy) - radiusOf(s, orig));
      if (copy?.type === "spline" && (orig?.type === "spline" || orig?.type === "ellipse")) {
        // From the copy's first point to the nearest place on the original.
        const q = pointPos(s, copy.points[0]);
        const path = curveParam(s, orig);
        const f = path.at(nearestParam(path, q));
        return Math.hypot(q[0] - f[0], q[1] - f[1]);
      }
      return 0;
    }
    case "arcLength": {
      const arc = curveById(s, a) as SketchArc;
      return radiusOf(s, arc) * arcSweep(s, arc);
    }
    case "arcAngle":
      return (arcSweep(s, curveById(s, a) as SketchArc) * 180) / Math.PI;
    case "rimDistance":
      return rimGap(s, c);
    default:
      return 0;
  }
}

/**
 * The gap a rim distance measures: between the edges of two circles or arcs
 * (nearest or furthest), or from a line to a circle's or arc's edge.
 */
function rimGap(s: SketchData, c: SketchConstraint): number {
  const ra = curveById(s, c.refs[0]) as SketchCircle | SketchArc;
  const other = curveById(s, c.refs[1]);
  const mode = c.extra?.[0] ?? -1;
  const [cx, cy] = pointPos(s, ra.center);
  const r1 = radiusOf(s, ra);
  if (other?.type === "line") {
    const h = measure(s, { id: "", type: "pointLineDistance", refs: [ra.center, other.id] });
    return h + mode * r1;
  }
  const rb = other as SketchCircle | SketchArc;
  const [qx, qy] = pointPos(s, rb.center);
  const d = Math.hypot(qx - cx, qy - cy);
  const r2 = radiusOf(s, rb);
  return mode > 0 ? d + r1 + r2 : c.extra?.[1] === 1 ? Math.abs(r1 - r2) - d : d - r1 - r2;
}

/** Where a distance dimension between circles, arcs and lines is measured to. */
export type MeasureTo = "centre" | "nearest" | "furthest";

/** The circles/arcs (and line) a distance dimension measures between, if it's that kind; else null. */
function roundsMeasured(s: SketchData, c: SketchConstraint): { a: SketchCircle | SketchArc; b: SketchCircle | SketchArc | SketchLine; now: MeasureTo } | null {
  const round = (id: string) => {
    const k = curveById(s, id);
    return k?.type === "circle" || k?.type === "arc" ? k : null;
  };
  // The circle or arc a centre point belongs to (circles first).
  const roundAt = (pointId: string) =>
    (s.curves.find((k) => k.type === "circle" && !k.construction && k.center === pointId) ??
      s.curves.find((k) => k.type === "arc" && !k.construction && k.center === pointId) ??
      s.curves.find((k) => (k.type === "circle" || k.type === "arc") && k.center === pointId)) as SketchCircle | SketchArc | undefined;
  if (c.type === "rimDistance") {
    const a = round(c.refs[0]);
    const other = curveById(s, c.refs[1]);
    const b = other?.type === "line" ? other : round(c.refs[1]);
    return a && b ? { a, b, now: (c.extra?.[0] ?? -1) > 0 ? "furthest" : "nearest" } : null;
  }
  if (c.type === "distance") {
    const a = roundAt(c.refs[0]);
    const b = roundAt(c.refs[1]);
    return a && b ? { a, b, now: "centre" } : null;
  }
  if (c.type === "pointLineDistance") {
    const a = roundAt(c.refs[0]);
    const line = curveById(s, c.refs[1]);
    return a && line?.type === "line" ? { a, b: line, now: "centre" } : null;
  }
  return null;
}

/** Whether a dimension can be measured to centres or edges, and which it is now (null: it can't). */
export function measureToOf(s: SketchData, c: SketchConstraint): MeasureTo | null {
  try {
    return roundsMeasured(s, c)?.now ?? null;
  } catch {
    return null;
  }
}

/**
 * Measure a distance between circles or arcs (or one and a line) to their
 * centres, their nearest edges or their furthest edges (Onshape's min/max).
 * The dimension keeps its current size and place; only what it measures changes.
 */
export function setMeasureTo(s: SketchData, id: string, to: MeasureTo): EditResult {
  const c = s.constraints.find((x) => x.id === id);
  const m = c ? roundsMeasured(s, c) : null;
  if (!c || !m) return { sketch: s, error: "Select a dimension between two circles or arcs, or a circle and a line." };
  if (m.now === to) return { sketch: s };
  let next: SketchConstraint;
  if (to === "centre") {
    next =
      m.b.type === "line"
        ? { ...c, type: "pointLineDistance", refs: [m.a.center, m.b.id], extra: undefined }
        : { ...c, type: "distance", refs: [m.a.center, m.b.center], extra: undefined };
  } else {
    let inside = 0;
    if (m.b.type !== "line") {
      const [ax, ay] = pointPos(s, m.a.center);
      const [bx, by] = pointPos(s, m.b.center);
      const d = Math.hypot(bx - ax, by - ay);
      const r1 = radiusOf(s, m.a), r2 = radiusOf(s, m.b);
      inside = d + Math.min(r1, r2) <= Math.max(r1, r2) + 1e-9 ? 1 : 0;
      if (to === "nearest" && !inside && d < r1 + r2 - 1e-9)
        return { sketch: s, error: "Those overlap, so there's no gap between their edges. Measure between their centres or their furthest edges instead." };
    } else if (to === "nearest" && measure(s, { id: "", type: "pointLineDistance", refs: [m.a.center, m.b.id] }) < radiusOf(s, m.a) - 1e-9) {
      return { sketch: s, error: "The line crosses the circle, so there's no gap to its edge. Measure to its centre or its far edge instead." };
    }
    next = { ...c, type: "rimDistance", refs: [m.a.id, m.b.id], extra: [to === "furthest" ? 1 : -1, inside] };
  }
  if (next.extra === undefined) delete next.extra;
  next.value = startingLength(measure(s, next));
  const sketch = { ...s, constraints: s.constraints.map((x) => (x.id === id ? next : x)) };
  if (c.driven) return { sketch };
  const r = solveSketch(sketch);
  return r.ok ? { sketch: r.sketch } : { sketch: s, error: "The sketch can't take that with its other constraints." };
}

/** Round a measured value for display / as a starting dimension value. */
/**
 * The two rays an angle dimension measures between: from the corner where its
 * two lines (extended) cross, along each line the way its `extra` flips say
 * (extra = [sign, flip1, flip2]; older dimensions have just [sign] and run the
 * way each line was drawn).
 */
export function angleRays(s: SketchData, c: SketchConstraint): { corner: [number, number]; u: [number, number]; w: [number, number] } {
  const l1 = curveById(s, c.refs[0]) as SketchLine;
  const l2 = curveById(s, c.refs[1]) as SketchLine;
  const [a1x, a1y] = pointPos(s, l1.p1);
  const [a2x, a2y] = pointPos(s, l2.p1);
  const d1 = lineDir(s, l1);
  const d2 = lineDir(s, l2);
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  let corner: [number, number];
  if (Math.abs(den) > 1e-12) {
    const t = ((a2x - a1x) * d2[1] - (a2y - a1y) * d2[0]) / den;
    corner = [a1x + d1[0] * t, a1y + d1[1] * t];
  } else {
    const [b1x, b1y] = pointPos(s, l1.p2);
    const [b2x, b2y] = pointPos(s, l2.p2);
    corner = [(a1x + b1x + a2x + b2x) / 4, (a1y + b1y + a2y + b2y) / 4];
  }
  const s1 = c.extra?.[1] ?? 1;
  const s2 = c.extra?.[2] ?? 1;
  const n1 = Math.hypot(d1[0], d1[1]) || 1;
  const n2 = Math.hypot(d2[0], d2[1]) || 1;
  return { corner, u: [(d1[0] * s1) / n1, (d1[1] * s1) / n1], w: [(d2[0] * s2) / n2, (d2[1] * s2) / n2] };
}

/**
 * The `extra` for an angle dimension whose label sits at `offset` from the
 * corner: the pair of rays (one along each line, either way) whose angle the
 * label lies within — so the label's side says whether the inside, outside or
 * a supplementary angle is meant — and which way round it is measured.
 */
export function angleExtraFor(s: SketchData, c: SketchConstraint, offset: [number, number]): number[] {
  const base = angleRays(s, { ...c, extra: [1, 1, 1] });
  const L: [number, number] = [offset[0], offset[1]];
  const cross = (p: [number, number], q: [number, number]) => p[0] * q[1] - p[1] * q[0];
  let pick: [number, number] = [c.extra?.[1] ?? 1, c.extra?.[2] ?? 1];
  if (Math.hypot(L[0], L[1]) > 1e-9) {
    for (const s1 of [1, -1]) {
      for (const s2 of [1, -1]) {
        const u: [number, number] = [base.u[0] * s1, base.u[1] * s1];
        const w: [number, number] = [base.w[0] * s2, base.w[1] * s2];
        const turn = cross(u, w);
        if (Math.abs(turn) < 1e-9) continue;
        // Inside the wedge from u round to w (the short way) when L turns the same way from u, and w from L.
        if (Math.sign(cross(u, L)) === Math.sign(turn) && Math.sign(cross(L, w)) === Math.sign(turn)) pick = [s1, s2];
      }
    }
  }
  const u: [number, number] = [base.u[0] * pick[0], base.u[1] * pick[0]];
  const w: [number, number] = [base.w[0] * pick[1], base.w[1] * pick[1]];
  return [Math.sign(cross(u, w)) || 1, pick[0], pick[1]];
}

export function roundValue(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

// ---------------------------------------------------------------------------
// Checked solving

/** Lines, circles and arcs that have shrunk to (almost) nothing. */
function collapsed(s: SketchData): Set<string> {
  const out = new Set<string>();
  for (const c of s.curves) {
    if (c.type === "line") {
      const [dx, dy] = lineDir(s, c);
      if (Math.hypot(dx, dy) < 1e-6) out.add(c.id);
    } else if (c.type === "spline") continue;
    else if (c.type === "ellipse") {
      const g = ellipseGeom(s, c);
      if (g.rx < 1e-6 || g.ry < 1e-6) out.add(c.id);
    }
    else if (radiusOf(s, c) < 1e-6) out.add(c.id);
  }
  return out;
}

/**
 * Solve a changed sketch and check the result is sensible: every constraint
 * met, nothing squashed to zero size and (optionally) the change actually
 * pins something down rather than repeating what's already set.
 */
function checkedSolve(before: SketchData, changed: SketchData, what: string, mustReduceFreedom: boolean): EditResult {
  const r = solveSketch(changed);
  if (!r.ok) return { sketch: before, error: `${what} would conflict with the sketch's other constraints or dimensions.` };
  const was = collapsed(before);
  if ([...collapsed(r.sketch)].some((id) => !was.has(id))) {
    return { sketch: before, error: `${what} would shrink a line or circle to nothing.` };
  }
  if (mustReduceFreedom && analyzeSketch(r.sketch).freedom >= analyzeSketch(before).freedom) {
    return { sketch: before, error: `That's already set by other constraints or dimensions, so ${what.toLowerCase()} isn't needed.` };
  }
  return { sketch: r.sketch };
}

// ---------------------------------------------------------------------------
// Adding geometry

export function settle(sketch: SketchData): EditResult {
  const r = solveSketch(sketch);
  return { sketch: r.sketch };
}

/** Resolve a placed point into a point id, adding the point and any snap constraint. */
/** The constraint that holds a point on a curve of this kind. */
export function onCurveType(c: SketchCurve): "pointOnLine" | "pointOnCircle" | "pointOnCurve" {
  return c.type === "line" ? "pointOnLine" : c.type === "circle" || c.type === "arc" ? "pointOnCircle" : "pointOnCurve";
}

export function placePoint(s: SketchData, p: Placed): { sketch: SketchData; id: string } {
  if (p.snap?.kind === "point" && isPointId(s, p.snap.id) && p.snap.id !== ORIGIN_ID) return { sketch: s, id: p.snap.id };
  if (p.snap?.kind === "ref") {
    // Bring the part edge in (as a reference), then attach to it.
    const at = p.snap.at;
    const used = linkEdge(s, p.snap.edge, true);
    if (used.error) return placePoint(s, { x: p.x, y: p.y, snap: null });
    const end = at === "a" ? used.points.a : at === "b" ? used.points.b : at === "centre" ? used.points.c : undefined;
    if (end) return { sketch: used.sketch, id: end };
    const k = used.sketch;
    const id = sketchId("p");
    const curve = curveById(k, used.curveId);
    const type = at === "mid" ? "midpoint" : curve ? onCurveType(curve) : "pointOnLine";
    return { sketch: { ...k, points: [...k.points, { id, x: p.x, y: p.y }], constraints: [...k.constraints, { id: sketchId("c"), type, refs: [id, used.curveId] }] }, id };
  }
  const id = sketchId("p");
  const points = [...s.points, { id, x: p.x, y: p.y }];
  const constraints = [...s.constraints];
  if (p.snap?.kind === "origin" || (p.snap?.kind === "point" && p.snap.id === ORIGIN_ID)) {
    constraints.push({ id: sketchId("c"), type: "coincident", refs: [id, ORIGIN_ID] });
  } else if (p.snap?.kind === "curve") {
    const c = curveById(s, p.snap.id);
    if (c) constraints.push({ id: sketchId("c"), type: onCurveType(c), refs: [id, c.id] });
  } else if (p.snap?.kind === "midpoint") {
    if (curveById(s, p.snap.id)?.type === "line") constraints.push({ id: sketchId("c"), type: "midpoint", refs: [id, p.snap.id] });
  } else if (p.snap?.kind === "align") {
    // Keep it lined up: straight above/below (vertical) and/or level with (horizontal) the point it snapped to.
    if (p.snap.x && (p.snap.x === ORIGIN_ID || isPointId(s, p.snap.x))) constraints.push({ id: sketchId("c"), type: "vertical", refs: [id, p.snap.x] });
    if (p.snap.y && (p.snap.y === ORIGIN_ID || isPointId(s, p.snap.y))) constraints.push({ id: sketchId("c"), type: "horizontal", refs: [id, p.snap.y] });
  }
  return { sketch: { ...s, points, constraints }, id };
}

export function addPoint(s: SketchData, at: Placed): EditResult & { pointId: string } {
  const placed = placePoint(s, at);
  const sketch = {
    ...placed.sketch,
    points: placed.sketch.points.map((p) => (p.id === placed.id ? { ...p, standalone: true } : p)),
  };
  return { ...settle(sketch), pointId: placed.id };
}

export interface LineOptions {
  construction?: boolean;
  /** Add an automatic horizontal or vertical constraint (inferred while drawing). */
  orientation?: "horizontal" | "vertical" | null;
}

export function addLine(s: SketchData, a: Placed, b: Placed, opts: LineOptions = {}): EditResult & { lineId: string; endId: string } {
  const pa = placePoint(s, a);
  const pb = placePoint(pa.sketch, b);
  if (pa.id === pb.id) return { sketch: s, lineId: "", endId: pa.id, error: "A line needs two different ends." };
  const id = sketchId("l");
  const line: SketchLine = { id, type: "line", p1: pa.id, p2: pb.id, construction: !!opts.construction };
  const constraints = [...pb.sketch.constraints];
  if (opts.orientation) constraints.push({ id: sketchId("c"), type: opts.orientation, refs: [id] });
  const result = settle({ ...pb.sketch, curves: [...pb.sketch.curves, line], constraints });
  return { ...result, lineId: id, endId: pb.id };
}

/** Rectangle from two opposite corners, with horizontal and vertical sides. */
export function addRectangle(s: SketchData, a: Placed, b: Placed, construction = false): EditResult & { lineIds: string[] } {
  if (Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6) {
    return { sketch: s, lineIds: [], error: "Drag out a rectangle with some width and height." };
  }
  const c1 = placePoint(s, a);
  const c3 = placePoint(c1.sketch, b);
  let sk = c3.sketch;
  const c2 = sketchId("p");
  const c4 = sketchId("p");
  sk = { ...sk, points: [...sk.points, { id: c2, x: b.x, y: a.y }, { id: c4, x: a.x, y: b.y }] };
  const corners = [c1.id, c2, c3.id, c4];
  const lineIds = corners.map(() => sketchId("l"));
  const lines: SketchLine[] = corners.map((p, i) => ({
    id: lineIds[i],
    type: "line",
    p1: p,
    p2: corners[(i + 1) % 4],
    construction,
  }));
  const constraints: SketchConstraint[] = [
    { id: sketchId("c"), type: "horizontal", refs: [lineIds[0]] },
    { id: sketchId("c"), type: "vertical", refs: [lineIds[1]] },
    { id: sketchId("c"), type: "horizontal", refs: [lineIds[2]] },
    { id: sketchId("c"), type: "vertical", refs: [lineIds[3]] },
  ];
  const result = settle({ ...sk, curves: [...sk.curves, ...lines], constraints: [...sk.constraints, ...constraints] });
  return { ...result, lineIds };
}

export function addCircle(s: SketchData, center: Placed, radius: number, construction = false): EditResult & { circleId: string } {
  if (radius < 1e-6) return { sketch: s, circleId: "", error: "Drag out the circle to give it a size." };
  const c = placePoint(s, center);
  const id = sketchId("k");
  const circle: SketchCircle = { id, type: "circle", center: c.id, radius, construction };
  return { ...settle({ ...c.sketch, curves: [...c.sketch.curves, circle] }), circleId: id };
}

/** Centre of the circle through three points, or null if they're in a line. */
export function circleThrough(a: [number, number], b: [number, number], c: [number, number]): [number, number] | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  return [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d,
  ];
}

/** Three-point arc: from `start` to `end`, bulging through `through` (like Onshape). */
export function addArc(s: SketchData, start: Placed, end: Placed, through: { x: number; y: number }, construction = false): EditResult & { arcId: string } {
  const centre = circleThrough([start.x, start.y], [through.x, through.y], [end.x, end.y]);
  if (!centre) return { sketch: s, arcId: "", error: "Those three points are in a line — move the last one to bend the arc." };
  const ps = placePoint(s, start);
  const pe = placePoint(ps.sketch, end);
  if (ps.id === pe.id) return { sketch: s, arcId: "", error: "An arc needs two different ends." };
  const cid = sketchId("p");
  let sk: SketchData = { ...pe.sketch, points: [...pe.sketch.points, { id: cid, x: centre[0], y: centre[1] }] };
  // Arcs run anticlockwise from start to end; swap if the user went clockwise.
  const cross = (end.x - start.x) * (through.y - start.y) - (end.y - start.y) * (through.x - start.x);
  const [from, to] = cross < 0 ? [ps.id, pe.id] : [pe.id, ps.id];
  const id = sketchId("a");
  const arc: SketchArc = { id, type: "arc", center: cid, start: from, end: to, construction };
  sk = { ...sk, curves: [...sk.curves, arc] };
  return { ...settle(sk), arcId: id };
}

// ---------------------------------------------------------------------------
// Deleting and construction

/** Delete curves, points and/or constraints, tidying up anything left dangling. */
export function deleteItems(s: SketchData, ids: string[]): SketchData {
  const gone = new Set(ids);
  // Deleting a point takes its lines, arcs and circles with it; a spline just loses that point
  // (and goes too if fewer than two are left).
  const curves = s.curves.flatMap((c): SketchCurve[] => {
    if (gone.has(c.id)) return [];
    if (c.type === "spline") {
      if (!c.points.some((id) => gone.has(id))) return [c];
      if (c.conic !== undefined) return [];
      const points = c.points.filter((id) => !gone.has(id));
      if (points.length < 2) return [];
      const keep = (h?: Record<string, [number, number]>) => (h ? Object.fromEntries(Object.entries(h).filter(([id]) => !gone.has(id))) : undefined);
      const tangents = keep(c.tangents);
      const tangentsIn = keep(c.tangentsIn);
      const offsetParams = c.offsetParams?.filter((_, i) => !gone.has(c.points[i]));
      const { tangents: _old, tangentsIn: _oldIn, offsetParams: _oldParams, ...rest } = c;
      void _old;
      void _oldIn;
      void _oldParams;
      return [
        {
          ...rest,
          points,
          closed: c.closed && points.length >= 3,
          ...(tangents && Object.keys(tangents).length ? { tangents } : {}),
          ...(tangentsIn && Object.keys(tangentsIn).length ? { tangentsIn } : {}),
          ...(offsetParams && offsetParams.length === points.length ? { offsetParams } : {}),
        },
      ];
    }
    return curvePoints(c).some((id) => gone.has(id)) ? [] : [c];
  });
  // Keep points still used by a curve, or that the user placed on their own (unless deleted).
  const used = new Set(curves.flatMap(curvePoints));
  const points = s.points.filter((p) => !gone.has(p.id) && (used.has(p.id) || (p.standalone && !gone.has(p.id))));
  const alive = new Set<string>([ORIGIN_ID, ...points.map((p) => p.id), ...curves.map((c) => c.id)]);
  const constraints = s.constraints.flatMap((c): SketchConstraint[] => {
    if (gone.has(c.id)) return [];
    if (c.type === "offset") {
      // An offset keeps the copies that are left.
      const refs: string[] = [];
      const extra: number[] = [];
      for (let i = 0; i + 1 < c.refs.length; i += 2) {
        if (!alive.has(c.refs[i]) || !alive.has(c.refs[i + 1])) continue;
        refs.push(c.refs[i], c.refs[i + 1]);
        if (c.extra?.[i / 2] !== undefined) extra.push(c.extra[i / 2]);
      }
      if (!refs.length) return [];
      if (refs.length === c.refs.length) return [c];
      return [{ ...c, refs, ...(c.extra ? { extra } : {}) }];
    }
    if (c.type === "patternMove" && c.refs.length === 3 && !alive.has(c.refs[2]) && alive.has(c.refs[0]) && alive.has(c.refs[1])) {
      // The row's direction line is gone: the copies carry on the way it pointed, at a set angle.
      const line = s.curves.find((k) => k.id === c.refs[2]);
      if (line?.type !== "line") return [];
      const [a, b] = [pointPos(s, line.p1), pointPos(s, line.p2)];
      const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      return [{ ...c, refs: c.refs.slice(0, 2), extra: [c.extra?.[0] ?? 0, angle] }];
    }
    return c.refs.every((r) => alive.has(r)) ? [c] : [];
  });
  return solveSketch({ ...s, points, curves, constraints }).sketch;
}

export function toggleConstruction(s: SketchData, curveIds: string[]): SketchData {
  const ids = new Set(curveIds);
  const targets = s.curves.filter((c) => ids.has(c.id));
  if (!targets.length) return s;
  const makeConstruction = targets.some((c) => !c.construction);
  return { ...s, curves: s.curves.map((c) => (ids.has(c.id) ? { ...c, construction: makeConstruction } : c)) };
}

// ---------------------------------------------------------------------------
// Constraints

export type RelationTool =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "tangent"
  | "concentric"
  | "midpoint"
  | "symmetric"
  | "normal"
  | "curvature"
  | "fix";

export const RELATION_LABELS: Record<RelationTool, string> = {
  coincident: "Coincident",
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  equal: "Equal",
  tangent: "Tangent",
  concentric: "Concentric",
  midpoint: "Midpoint",
  symmetric: "Symmetric",
  normal: "Normal",
  curvature: "Curvature",
  fix: "Fix",
};

/** What to select for each relation, in plain English. */
export const RELATION_HINTS: Record<RelationTool, string> = {
  coincident: "Select two points, or a point and a line, circle, arc, spline or ellipse",
  horizontal: "Select one or more lines, or two points",
  vertical: "Select one or more lines, or two points",
  parallel: "Select two or more lines",
  perpendicular: "Select two lines",
  equal: "Select two or more lines (same length), or two or more circles/arcs (same size)",
  tangent: "Select two curves to touch smoothly: lines, circles, arcs, splines or ellipses",
  concentric: "Select two circles, arcs or ellipses",
  midpoint: "Select a point and a line or arc — or three points (the first goes halfway between the other two)",
  symmetric: "Select two points (or two lines, circles or arcs) and then the line they mirror across",
  normal: "Select a line and a curve: the line meets the curve square on (through the centre of a circle or arc)",
  curvature: "Select a spline and the line, arc or spline its end joins: they meet smoothly and bend the same amount there",
  fix: "Select the points or shapes to hold in place",
};

const isLine = (c?: SketchCurve): c is SketchLine => c?.type === "line";

/** Where a point lands when mirrored across a line. */
export function mirrorPoint(s: SketchData, axis: SketchLine, [x, y]: [number, number]): [number, number] {
  const [ax, ay] = pointPos(s, axis.p1);
  const [bx, by] = pointPos(s, axis.p2);
  const dx = bx - ax, dy = by - ay;
  const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1);
  const fx = ax + t * dx, fy = ay + t * dy;
  return [2 * fx - x, 2 * fy - y];
}
const isRound = (c?: SketchCurve): c is SketchCircle | SketchArc => c?.type === "circle" || c?.type === "arc";
const isWavy = (c?: SketchCurve): c is SketchSpline | SketchEllipse => c?.type === "spline" || c?.type === "ellipse";

/** The ends of a curve, where another can join it (none for a circle, a whole ellipse or a closed spline). */
export function curveEnds(c: SketchCurve): string[] {
  if (c.type === "line") return [c.p1, c.p2];
  if (c.type === "arc") return [c.start, c.end];
  if (c.type === "spline") return c.closed ? [] : [c.points[0], c.points[c.points.length - 1]];
  if (c.type === "ellipse" && c.start && c.end) return [c.start, c.end];
  return [];
}

function relationConstraints(s: SketchData, tool: RelationTool, sel: string[]): SketchConstraint[] | string {
  const pts = sel.filter((id) => isPointId(s, id));
  const crv = sel.map((id) => curveById(s, id)).filter((c): c is SketchCurve => !!c);
  const lines = crv.filter(isLine);
  const rounds = crv.filter(isRound);
  const mk = (type: RelationType, refs: string[], extra?: number[]): SketchConstraint => ({ id: sketchId("c"), type, refs, extra });
  const only = (n: number) => sel.length === n;

  switch (tool) {
    case "coincident":
      if (only(2) && pts.length === 2) return [mk("coincident", pts)];
      if (only(2) && pts.length === 1 && crv.length === 1) {
        if (curvePoints(crv[0]).includes(pts[0])) return "That point is already part of that shape.";
        return [mk(onCurveType(crv[0]), [pts[0], crv[0].id])];
      }
      break;
    case "horizontal":
    case "vertical":
      if (lines.length && lines.length === sel.length) return lines.map((l) => mk(tool, [l.id]));
      if (only(2) && pts.length === 2) return [mk(tool, pts)];
      break;
    case "parallel":
      if (lines.length >= 2 && lines.length === sel.length) return lines.slice(1).map((l) => mk("parallel", [lines[0].id, l.id]));
      break;
    case "perpendicular":
      if (only(2) && lines.length === 2) return [mk("perpendicular", [lines[0].id, lines[1].id])];
      break;
    case "equal":
      if (lines.length >= 2 && lines.length === sel.length) return lines.slice(1).map((l) => mk("equal", [lines[0].id, l.id]));
      if (rounds.length >= 2 && rounds.length === sel.length) return rounds.slice(1).map((r) => mk("equal", [rounds[0].id, r.id]));
      // Like Onshape: lines are made the same length and circles/arcs the same size, but a line isn't matched to an arc.
      if (lines.length && rounds.length && lines.length + rounds.length === sel.length)
        return "Equal makes lines the same length, or circles and arcs the same size — not a line and an arc together. Select only lines, or only circles and arcs.";
      break;
    case "tangent":
      if (only(2) && crv.length === 2 && crv.some(isWavy)) {
        // An end that sits on the other curve (without being joined to it) is held there, so they meet smoothly at that point.
        const held: SketchConstraint[] = [];
        for (const [one, two] of [[crv[0], crv[1]], [crv[1], crv[0]]] as const) {
          const path = curveParam(s, two);
          for (const p of curveEnds(one)) {
            if (curvePoints(two).includes(p)) continue;
            const q = pointPos(s, p);
            const f = path.at(nearestParam(path, q));
            const joined = s.constraints.some((k) => k.refs[0] === p && k.refs[1] === two.id) || s.constraints.some((k) => k.type === "coincident" && k.refs.includes(p) && k.refs.some((r) => r !== p && curvePoints(two).includes(r)));
            if (!joined && !held.length && Math.hypot(q[0] - f[0], q[1] - f[1]) < 1e-6) held.push(mk(onCurveType(two), [p, two.id]));
          }
        }
        return [...held, mk("tangent", [crv[0].id, crv[1].id])];
      }
      if (only(2) && lines.length === 1 && rounds.length === 1) return [mk("tangent", [lines[0].id, rounds[0].id])];
      if (only(2) && rounds.length === 2) {
        const [c1, c2] = rounds;
        const [ax, ay] = pointPos(s, c1.center);
        const [bx, by] = pointPos(s, c2.center);
        const d = Math.hypot(bx - ax, by - ay);
        const internal = d < Math.max(radiusOf(s, c1), radiusOf(s, c2));
        return [mk("tangent", [c1.id, c2.id], [internal ? 1 : 0])];
      }
      break;
    case "concentric": {
      const centred = crv.filter((c) => isRound(c) || c.type === "ellipse");
      if (only(2) && centred.length === 2) return [mk("concentric", [centred[0].id, centred[1].id])];
      break;
    }
    case "normal": {
      if (only(2) && lines.length === 2) return "Two lines at right angles: use Perpendicular for that. Normal is for a line and a curve.";
      if (!(only(2) && lines.length === 1 && crv.length === 2)) break;
      const line = lines[0];
      const curve = crv.find((c) => c !== line)!;
      if (isRound(curve)) return [mk("normal", [line.id, curve.id])];
      // The line's end at (or nearest) the curve is where it meets it square on.
      const path = curveParam(s, curve);
      const gap = (id: string) => {
        const q = pointPos(s, id);
        const f = path.at(nearestParam(path, q));
        return Math.hypot(q[0] - f[0], q[1] - f[1]);
      };
      return [mk("normal", [line.id, curve.id], [gap(line.p2) < gap(line.p1) ? 1 : 0])];
    }
    case "curvature": {
      if (!only(2) || crv.length !== 2) break;
      const spline = crv.find((c) => c.type === "spline");
      if (!spline) return "Curvature joins a spline to what its end meets — select a spline, and the line, arc or spline at its end.";
      const other = crv.find((c) => c !== spline)!;
      if (other.type === "circle" || (other.type === "ellipse" && !(other.start && other.end)))
        return "Curvature needs the spline's end to join the other curve's end. A whole circle or ellipse has no ends — trim it first, or use Tangent.";
      const joint = curveEnds(spline).find((p) => curveEnds(other).includes(p));
      if (!joint) return "Curvature needs the spline's end joined to the other curve's end. Drag the end onto it first (so they share a point), then try again.";
      return [mk("curvature", [spline.id, other.id, joint])];
    }
    case "midpoint":
      if (only(2) && pts.length === 1 && lines.length === 1) return [mk("midpoint", [pts[0], lines[0].id])];
      // Three points: the first goes halfway between the other two.
      if (only(3) && pts.length === 3) return [mk("midpoint", pts)];
      if (only(2) && pts.length === 1 && rounds.length === 1 && rounds[0].type === "arc") {
        if ([rounds[0].start, rounds[0].end, rounds[0].center].includes(pts[0])) return "That point is already one of the arc's own points — pick a different point.";
        return [mk("midpoint", [pts[0], rounds[0].id])];
      }
      break;
    case "symmetric": {
      // The mirror line is the last thing selected.
      const axis = curveById(s, sel[sel.length - 1]);
      if (!isLine(axis) || sel.length !== 3) break;
      const rest = sel.slice(0, 2);
      if (rest.every((id) => isPointId(s, id))) return [mk("symmetric", [rest[0], rest[1], axis.id])];
      const [c1, c2] = rest.map((id) => curveById(s, id));
      if (isLine(c1) && isLine(c2)) {
        // Pair each end with the end of the other line nearest its mirror image.
        const [a1, a2] = [c1.p1, c1.p2].map((id) => mirrorPoint(s, axis, pointPos(s, id)));
        const d = (p: [number, number], id: string) => Math.hypot(p[0] - pointPos(s, id)[0], p[1] - pointPos(s, id)[1]);
        const straight = d(a1, c2.p1) + d(a2, c2.p2) <= d(a1, c2.p2) + d(a2, c2.p1);
        return [mk("symmetric", [c1.p1, straight ? c2.p1 : c2.p2, axis.id]), mk("symmetric", [c1.p2, straight ? c2.p2 : c2.p1, axis.id])];
      }
      if (isRound(c1) && isRound(c2)) return [mk("symmetric", [c1.center, c2.center, axis.id]), mk("equal", [c1.id, c2.id])];
      break;
    }
    case "fix": {
      const ids = new Set([...pts.filter((p) => p !== ORIGIN_ID), ...crv.flatMap(curvePoints).filter((p) => p !== ORIGIN_ID)]);
      if (ids.size) return [...ids].map((p) => mk("fix", [p], pointPos(s, p)));
      break;
    }
  }
  return RELATION_HINTS[tool] + ".";
}

/** Apply a relation (horizontal, tangent, …) to the selection. */
export function applyRelation(s: SketchData, tool: RelationTool, selection: string[]): EditResult {
  const made = relationConstraints(s, tool, selection);
  if (typeof made === "string") return { sketch: s, error: made };
  let start = s;
  if (tool === "curvature") {
    // Curvature includes meeting smoothly, so a tangent between the same two is replaced.
    const [a, b] = made[0].refs;
    start = { ...s, constraints: s.constraints.filter((k) => !(k.type === "tangent" && k.refs.includes(a) && k.refs.includes(b))) };
  }
  if (tool === "horizontal" || tool === "vertical") {
    // A line already square to the way it's asked to go would be squashed to a
    // point by the nearest solution; turn it about its middle first so the
    // solver starts from a line that way round.
    start = turnedTowards(s, made, tool);
  }
  const r = checkedSolve(start, { ...start, constraints: [...start.constraints, ...made] }, RELATION_LABELS[tool], true);
  return r.error ? { sketch: s, error: r.error } : r;
}

/** Lines about to be made horizontal/vertical that run (nearly) the other way, turned about their middles to the new direction. */
function turnedTowards(s: SketchData, made: SketchConstraint[], tool: "horizontal" | "vertical"): SketchData {
  const moves = new Map<string, [number, number]>();
  for (const c of made) {
    if (c.refs.length !== 1) continue;
    const line = curveById(s, c.refs[0]);
    if (!isLine(line)) continue;
    const [ax, ay] = pointPos(s, line.p1);
    const [bx, by] = pointPos(s, line.p2);
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const across = tool === "horizontal" ? Math.abs(dx) / len : Math.abs(dy) / len;
    if (across > 0.3) continue; // already leaning the right way: the solver can swing it round
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const sign = tool === "horizontal" ? Math.sign(dy) || 1 : Math.sign(dx) || 1;
    const half = len / 2;
    if (tool === "horizontal") {
      moves.set(line.p1, [mx - sign * half, my]);
      moves.set(line.p2, [mx + sign * half, my]);
    } else {
      moves.set(line.p1, [mx, my - sign * half]);
      moves.set(line.p2, [mx, my + sign * half]);
    }
  }
  if (!moves.size) return s;
  return { ...s, points: s.points.map((p) => (moves.has(p.id) ? { ...p, x: moves.get(p.id)![0], y: moves.get(p.id)![1] } : p)) };
}

// ---------------------------------------------------------------------------
// Dimensions

/** Work out which dimension to add for the selection (like Onshape's single Dimension tool). */
export function dimensionFor(s: SketchData, sel: string[]): { type: ConstraintType; refs: string[]; extra?: number[] } | string {
  const pts = sel.filter((id) => isPointId(s, id));
  const crv = sel.map((id) => curveById(s, id)).filter((c): c is SketchCurve => !!c);
  if (sel.length === 1 && crv.length === 1) {
    const c = crv[0];
    if (c.type === "line") return { type: "length", refs: [c.id] };
    if (c.type === "circle") return { type: "diameter", refs: [c.id] };
    if (c.type === "spline") return "A spline can't be dimensioned as a whole — dimension its points instead.";
    if (c.type === "ellipse") return "Dimension an ellipse from its centre to the points at the ends of its axes.";
    return { type: "radius", refs: [c.id] };
  }
  if (sel.length === 2 && pts.length === 2) return { type: "distance", refs: pts };
  // An arc and its own centre: how far round it goes. An arc and one of its ends: how long it is.
  if (sel.length === 2 && pts.length === 1 && crv.length === 1 && crv[0].type === "arc") {
    const arc = crv[0];
    if (pts[0] === arc.center) return { type: "arcAngle", refs: [arc.id] };
    if (pts[0] === arc.start || pts[0] === arc.end) return { type: "arcLength", refs: [arc.id] };
  }
  if (sel.length === 2 && pts.length === 1 && crv.length === 1 && isLine(crv[0])) return { type: "pointLineDistance", refs: [pts[0], crv[0].id] };
  // Circles and arcs are measured from their centres (like Onshape).
  if (sel.length === 2 && crv.length >= 1 && crv.every((c) => isLine(c) || isRound(c)) && crv.some(isRound)) {
    const rounds = crv.filter(isRound);
    const line = crv.find(isLine);
    if (line) return { type: "pointLineDistance", refs: [rounds[0].center, line.id] };
    const ends = [...pts, ...rounds.map((c) => c.center)];
    if (ends[0] === ends[1]) return "Those share the same centre — dimension their sizes instead.";
    return { type: "distance", refs: ends };
  }
  if (sel.length === 2 && crv.length === 2 && isLine(crv[0]) && isLine(crv[1])) {
    const [ux, uy] = lineDir(s, crv[0]);
    const [wx, wy] = lineDir(s, crv[1]);
    const cross = ux * wy - uy * wx;
    const lens = Math.hypot(ux, uy) * Math.hypot(wx, wy) || 1;
    if (Math.abs(cross) / lens < 1e-3) return { type: "pointLineDistance", refs: [crv[1].p1, crv[0].id] };
    return { type: "angle", refs: [crv[0].id, crv[1].id], extra: [Math.sign(cross) || 1] };
  }
  return "Select a line, circle or arc — or two things to measure between (points, lines, circles or arcs).";
}

/** Add a dimension for the selection, starting at its current size. */
/**
 * A distance between two points that run on a slant becomes a horizontal or
 * vertical distance when its label is placed above/below or beside them (like
 * Onshape); in the diagonal corners it stays a straight-line distance.
 * `labelOffset` is measured from halfway between the points.
 */
export function placedDistance(
  a: [number, number],
  b: [number, number],
  labelOffset: { x: number; y: number },
  ofLine = false,
): "distance" | "horizontalDistance" | "verticalDistance" {
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  const size = Math.max(dx, dy);
  // Already level or upright: all three are the same.
  if (size < 1e-9 || dx < 1e-3 * size || dy < 1e-3 * size) return "distance";
  // A line's own length whenever the label sits beside it (between its ends); across or up only past its ends.
  if (ofLine) {
    const along = Math.abs((labelOffset.x * (b[0] - a[0]) + labelOffset.y * (b[1] - a[1])) / Math.hypot(b[0] - a[0], b[1] - a[1]));
    if (along <= Math.hypot(b[0] - a[0], b[1] - a[1]) / 2) return "distance";
  }
  const besideX = Math.abs(labelOffset.x) <= dx / 2;
  const besideY = Math.abs(labelOffset.y) <= dy / 2;
  if (besideX && !besideY) return "horizontalDistance";
  if (besideY && !besideX) return "verticalDistance";
  return "distance";
}

/** The dimension the selection gets with its label at `labelOffset`: across, up or straight for two points or a slanted line. */
export function dimensionSpecAt(
  s: SketchData,
  sel: string[],
  labelOffset: { x: number; y: number },
): { type: ConstraintType; refs: string[]; extra?: number[] } | string {
  let spec = dimensionFor(s, sel);
  if (typeof spec === "string") return spec;
  // Two points, or a slanted line, can be measured across or up instead, by where the label goes.
  if (spec.type === "distance" || spec.type === "length") {
    const ends = spec.type === "distance" ? spec.refs : (() => {
      const l = curveById(s, spec.refs[0]) as SketchLine;
      return [l.p1, l.p2];
    })();
    const A = pointPos(s, ends[0]);
    const B = pointPos(s, ends[1]);
    const kind = placedDistance(A, B, labelOffset, spec.type === "length");
    if (kind !== "distance") {
      const k = kind === "horizontalDistance" ? 0 : 1;
      spec = { type: kind, refs: ends, extra: [Math.sign(B[k] - A[k]) || 1] };
    }
  }
  return spec;
}

export function addDimension(
  s: SketchData,
  sel: string[],
  labelOffset: { x: number; y: number } = { x: 0, y: 0 },
): EditResult & { dimensionId: string; driven?: boolean } {
  const spec = dimensionSpecAt(s, sel, labelOffset);
  if (typeof spec === "string") return { sketch: s, error: spec, dimensionId: "" };
  const id = sketchId("d");
  const draft: SketchConstraint = { id, ...spec, value: "0", labelOffset };
  // An angle measures the wedge the label was placed in (inside, outside or supplementary).
  if (draft.type === "angle") draft.extra = angleExtraFor(s, draft, [labelOffset.x, labelOffset.y]);
  // Lengths start in the design's units (angles in degrees).
  draft.value = isAngleDimension(draft) ? roundValue(measure(s, draft)) : startingLength(measure(s, draft));
  const r = checkedSolve(s, { ...s, constraints: [...s.constraints, draft] }, "A dimension", true);
  if (r.error) {
    // With a conflict already in the sketch, nothing new can be checked: that has to be sorted out first.
    if (!solveSketch(s).ok) return { sketch: s, error: CONFLICT_FIRST, dimensionId: "" };
    // Already set by other constraints: add it as a reference dimension (shown in brackets), like Onshape's driven dimensions.
    return { sketch: { ...s, constraints: [...s.constraints, { ...draft, driven: true }] }, dimensionId: id, driven: true };
  }
  return { sketch: r.sketch, dimensionId: id };
}

/**
 * Make a dimension a reference (it shows the size and never changes the
 * sketch) or a driving one again (it holds the size it shows). Making it
 * driving fails if that would over-define the sketch.
 */
export function setDimensionDriven(s: SketchData, id: string, driven: boolean): EditResult {
  const c = s.constraints.find((x) => x.id === id);
  if (!c || !isDimension(c)) return { sketch: s, error: "Select a dimension first." };
  if (!!c.driven === driven) return { sketch: s };
  // Its value as typed (an expression or a variable) is kept while it's a reference, and used again if it still matches.
  if (driven) return { sketch: { ...s, constraints: s.constraints.map((x) => (x.id === id ? { ...c, driven: true } : x)) } };
  const { driven: _d, ...rest } = c;
  void _d;
  const others = { ...s, constraints: s.constraints.filter((x) => x.id !== id) };
  if (!solveSketch(others).ok) return { sketch: s, error: CONFLICT_FIRST };
  const typed = evaluate(c.value ?? "");
  const now = measure(s, c);
  const matches = typed.ok && Math.abs(typed.value - now) <= 1e-6 * Math.max(1, Math.abs(now));
  const back = { ...rest, value: matches ? c.value! : valueNow(s, c) };
  const r = checkedSolve(others, { ...others, constraints: [...others.constraints, back] }, "That dimension", true);
  if (r.error) return { sketch: s, error: "That size is already set by other constraints or dimensions, so it has to stay as just showing the size. Delete one of those first." };
  // Keep the dimension in its place in the list.
  return { sketch: { ...r.sketch, constraints: s.constraints.map((x) => (x.id === id ? back : r.sketch.constraints.find((k) => k.id === x.id) ?? x)) } };
}

const CONFLICT_FIRST = "Some of the sketch's constraints or dimensions can't all be met (shown in red). Fix or delete those first, then try again.";

/** A dimension's current size as a value to store (degrees for angles, the design's units for lengths). */
function valueNow(s: SketchData, c: SketchConstraint): string {
  const v = measure(s, c);
  return isAngleDimension(c) ? roundValue(v) : startingLength(v);
}

/** The sketch with an arc's end turned round its centre so the arc has the given angle (°) or length (mm). */
function turnArcEnd(s: SketchData, c: SketchConstraint, value: number): SketchData {
  const arc = curveById(s, c.refs[0]);
  if (arc?.type !== "arc" || arc.end === ORIGIN_ID) return s;
  const [cx, cy] = pointPos(s, arc.center);
  const [sx, sy] = pointPos(s, arc.start);
  const r = Math.hypot(sx - cx, sy - cy);
  if (r <= 1e-9) return s;
  const sweep = c.type === "arcAngle" ? (value * Math.PI) / 180 : value / r;
  if (!(sweep > 0) || sweep >= 2 * Math.PI) return s;
  const a = Math.atan2(sy - cy, sx - cx) + sweep;
  return { ...s, points: s.points.map((p) => (p.id === arc.end ? { ...p, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) } : p)) };
}

/** Change a dimension's value (any expression, e.g. "20", "10 + 5", "1 in"). */
export function setDimensionValue(s: SketchData, id: string, value: string): EditResult {
  const c = s.constraints.find((x) => x.id === id);
  if (!c || !isDimension(c)) return { sketch: s, error: "That dimension no longer exists." };
  if (c.driven) return { sketch: s, error: "That dimension (in brackets) just shows the size. Select it and click \"Let it set the size\" in the sketch panel first." };
  const r = evaluate(value);
  if (!r.ok) return { sketch: s, error: r.error };
  if (c.type !== "angle" && r.value <= 0 && c.type !== "pointLineDistance") return { sketch: s, error: "Must be more than 0." };
  if (c.type === "pointLineDistance" && r.value < 0) return { sketch: s, error: "Can't be negative." };
  if (c.type === "arcAngle" && r.value >= 360) return { sketch: s, error: "An arc goes less than all the way round: use less than 360°." };
  // An arc's length or angle: turn its end round the centre to the new size first, so the solver keeps its radius.
  const start = c.type === "arcAngle" || c.type === "arcLength" ? turnArcEnd(s, c, r.value) : s;
  const solved = checkedSolve(s, { ...start, constraints: s.constraints.map((x) => (x.id === id ? { ...x, value } : x)) }, "That value", false);
  if (solved.error) {
    // An offset going inwards can't be wider than the rounded corners (arcs) it goes round.
    const curved = c.type === "offset" && c.refs.some((id) => curveById(s, id)?.type === "arc");
    return {
      sketch: s,
      error: curved
        ? "That gap is too big to fit inside the rounded corners — use a smaller gap than the corner rounding."
        : "The sketch can't take that value with its other constraints.",
    };
  }
  return solved;
}

export function moveDimensionLabel(s: SketchData, id: string, labelOffset: { x: number; y: number }): SketchData {
  return {
    ...s,
    constraints: s.constraints.map((c) => {
      if (c.id !== id) return c;
      if (c.type !== "angle") return { ...c, labelOffset };
      // Dragged into another wedge: the dimension measures that angle instead (the lines stay where they are).
      const extra = angleExtraFor(s, c, [labelOffset.x, labelOffset.y]);
      const moved = { ...c, labelOffset, extra };
      if (extra[1] === (c.extra?.[1] ?? 1) && extra[2] === (c.extra?.[2] ?? 1)) return moved;
      return { ...moved, value: roundValue(measure(s, moved)) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Dragging

export function dragPoint(s: SketchData, pointId: string, x: number, y: number): SketchData {
  const r = solveSketch(s, { drag: { pointId, x, y } });
  return r.ok ? r.sketch : s;
}

/** Points that share a line, arc or circle with `pointId` (snapping a point onto one of these would squash that shape). */
export function pointsSharingCurve(s: SketchData, pointId: string): Set<string> {
  const out = new Set<string>([pointId]);
  for (const c of s.curves) {
    const ps = curvePoints(c);
    if (ps.includes(pointId)) ps.forEach((id) => out.add(id));
  }
  return out;
}

/**
 * Join a point dragged onto another point (or the origin): they're held
 * together with a coincident constraint from then on.
 */
export function joinPoints(s: SketchData, pointId: string, targetId: string): EditResult {
  if (pointId === targetId) return { sketch: s };
  if (pointsSharingCurve(s, pointId).has(targetId)) return { sketch: s, error: "Those two points are on the same line, arc or circle." };
  const already = s.constraints.some((c) => c.type === "coincident" && c.refs.includes(pointId) && c.refs.includes(targetId));
  if (already) return { sketch: s };
  const [x, y] = pointPos(s, targetId);
  const moved = { ...s, points: s.points.map((p) => (p.id === pointId ? { ...p, x, y } : p)) };
  const r = solveSketch({ ...moved, constraints: [...s.constraints, { id: sketchId("c"), type: "coincident", refs: [pointId, targetId] }] });
  if (!r.ok) return { sketch: s, error: "That point can't join the other one — it's held in place by other constraints or dimensions." };
  return { sketch: r.sketch };
}

/** Move a whole curve by (dx, dy) from its position in `start`. */
export function dragCurve(start: SketchData, curveId: string, dx: number, dy: number): SketchData {
  const c = curveById(start, curveId);
  if (!c) return start;
  const r = solveSketch(start, { moveRigid: { pointIds: curvePoints(c).filter((p) => p !== ORIGIN_ID), dx, dy } });
  return r.ok ? r.sketch : start;
}

/** Drag a circle's rim to resize it. */
export function dragCircleRim(start: SketchData, circleId: string, radius: number): SketchData {
  if (radius <= 1e-6) return start;
  const r = solveSketch(start, { resize: { circleId, radius } });
  return r.ok ? r.sketch : start;
}

/**
 * Drag an arc's rim to resize it (like a circle's): its centre stays put and
 * its ends move straight out from (or in towards) the centre, keeping the
 * arc's angle, as far as its relations allow.
 */
export function dragArcRim(start: SketchData, arcId: string, radius: number): SketchData {
  const c = curveById(start, arcId);
  if (c?.type !== "arc" || radius <= 1e-6) return start;
  if (start.constraints.some((k) => k.type === "tangent" && k.refs.includes(arcId))) {
    // A rounded corner (tangent to what it joins): keep everything else where it is and let the
    // arc's centre and ends slide to the new size, like changing a fillet's radius.
    const own = new Set([c.center, c.start, c.end]);
    const place = start.points.filter((p) => !own.has(p.id)).map((p) => ({ pointId: p.id, x: p.x, y: p.y }));
    const sized: SketchData = { ...start, constraints: [...start.constraints, { id: "__rim", type: "radius", refs: [arcId], value: String(radius) }] };
    const r = solveSketch(sized, { place });
    if (!r.ok) return start;
    const moved = r.sketch.points.filter((p) => !own.has(p.id)).some((p) => {
      const q = start.points.find((x) => x.id === p.id)!;
      return Math.hypot(p.x - q.x, p.y - q.y) > 1e-6;
    });
    if (moved) return start;
    // Too big a round would push a joined line's end past its other end (folding the side back on itself).
    const folds = start.curves.some((l) => {
      if (l.type !== "line" || !(own.has(l.p1) || own.has(l.p2))) return false;
      const [ax, ay] = pointPos(start, l.p1), [bx, by] = pointPos(start, l.p2);
      const [cx2, cy2] = pointPos(r.sketch, l.p1), [dx2, dy2] = pointPos(r.sketch, l.p2);
      const nx = dx2 - cx2, ny = dy2 - cy2;
      return Math.hypot(nx, ny) < 1e-6 || nx * (bx - ax) + ny * (by - ay) <= 0;
    });
    if (folds) return start;
    return { ...r.sketch, constraints: start.constraints };
  }
  const [cx, cy] = pointPos(start, c.center);
  const out = (id: string) => {
    const [x, y] = pointPos(start, id);
    const r = Math.hypot(x - cx, y - cy) || 1;
    return { pointId: id, x: cx + ((x - cx) * radius) / r, y: cy + ((y - cy) * radius) / r };
  };
  const place = [out(c.start), out(c.end), { pointId: c.center, x: cx, y: cy }].filter((p) => p.pointId !== ORIGIN_ID);
  const r = solveSketch(start, { place });
  return r.ok ? r.sketch : start;
}

/** A spline's points where they are now. */
export function splinePoints(s: SketchData, c: SketchSpline): [number, number][] {
  return c.points.map((id) => pointPos(s, id));
}

/** The handles the user has set on a spline, one entry per point (undefined where the curve runs naturally). */
export function splineHandles(c: SketchSpline): ([number, number] | undefined)[] {
  return c.points.map((id) => c.tangents?.[id]);
}

/** Where a spline arrives at a point differently than it leaves (after Split or Trim), one entry per point. */
export function splineHandlesIn(c: SketchSpline): ([number, number] | undefined)[] {
  return c.points.map((id) => c.tangentsIn?.[id]);
}

/** The nearest place to `p` on a path of short straight pieces. */
export function nearestOnPath(path: [number, number][], p: [number, number]): [number, number] {
  let best: [number, number] = path[0] ?? p;
  let bestD = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i];
    const dx = path[i + 1][0] - ax, dy = path[i + 1][1] - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
    const q: [number, number] = [ax + t * dx, ay + t * dy];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** The spline drawn as short straight pieces. */
export function splinePath(s: SketchData, c: SketchSpline, steps?: number): [number, number][] {
  return splinePolyline(splinePoints(s, c), c.closed, steps, c.conic, splineHandles(c), splineHandlesIn(c));
}

/** One end of a spline point's handle: dragging it sets the curve's direction and speed there. */
export interface SplineHandleEnd {
  splineId: string;
  pointId: string;
  /** Which end of the handle: +1 along the curve, −1 against it. */
  side: 1 | -1;
  at: [number, number];
}

/**
 * The handle ends of the splines to show handles for: those selected, or with
 * a point of theirs selected (a conic has none — it's shaped by its corner).
 */
export function splineHandleEnds(s: SketchData, selection: Iterable<string>): SplineHandleEnd[] {
  const sel = new Set(selection);
  const out: SplineHandleEnd[] = [];
  for (const c of s.curves) {
    if (c.type !== "spline" || c.conic !== undefined) continue;
    if (!sel.has(c.id) && !c.points.some((id) => sel.has(id))) continue;
    const pts = splinePoints(s, c);
    const tangents = splineTangents(pts, c.closed, splineHandles(c));
    c.points.forEach((pointId, i) => {
      const [x, y] = pts[i];
      const [tx, ty] = tangents[i];
      // A handle end sits where the curve's Bézier control is: a third of the tangent out from the point.
      const [ix, iy] = c.tangentsIn?.[pointId] ?? [tx, ty];
      out.push({ splineId: c.id, pointId, side: 1, at: [x + tx / 3, y + ty / 3] });
      out.push({ splineId: c.id, pointId, side: -1, at: [x - ix / 3, y - iy / 3] });
    });
  }
  return out;
}

/**
 * Set (or, with null, clear) the handle at one point of a spline: the curve's
 * direction and speed there. Dragging a handle end sets it; the opposite end
 * follows, so the curve stays smooth through the point.
 */
export function setSplineHandle(s: SketchData, splineId: string, pointId: string, tangent: [number, number] | null): SketchData {
  return {
    ...s,
    curves: s.curves.map((c) => {
      if (c.id !== splineId || c.type !== "spline" || !c.points.includes(pointId)) return c;
      const tangents = { ...(c.tangents ?? {}) };
      if (tangent) tangents[pointId] = tangent;
      else delete tangents[pointId];
      // One handle through the point again: it arrives the way it leaves.
      const tangentsIn = { ...(c.tangentsIn ?? {}) };
      delete tangentsIn[pointId];
      const { tangents: _old, tangentsIn: _oldIn, ...rest } = c;
      void _old;
      void _oldIn;
      return { ...rest, ...(Object.keys(tangents).length ? { tangents } : {}), ...(Object.keys(tangentsIn).length ? { tangentsIn } : {}) };
    }),
  };
}

/** An ellipse as short straight pieces (closed: the last point repeats the first). */
export function ellipsePoints(s: SketchData, c: SketchEllipse, steps = 64): [number, number][] {
  if (c.start && c.end) {
    // Part of an ellipse: just that stretch.
    const { g, t0, t1 } = ellipseSpan(s, c);
    const n = Math.max(4, Math.ceil((steps * (t1 - t0)) / (2 * Math.PI)));
    return Array.from({ length: n + 1 }, (_, i) => ellipseAtParam(g, t0 + ((t1 - t0) * i) / n));
  }
  return ellipsePolyline(ellipseGeom(s, c), steps);
}
