/**
 * Part edges in a sketch (Onshape's reference geometry and "Use").
 *
 * When a sketch sits on a part's face, the face's edges (its outline and the
 * edges of any holes in it) are shown faintly in the sketch. They aren't part
 * of the sketch until they're needed: snapping to one of their corners, or
 * dimensioning to one, copies that edge in as a *reference* — a construction
 * line, circle or arc that is fixed where the edge is and remembers the edge
 * (`link`). "Use" copies one in as real geometry the same way. On every
 * rebuild the geometry engine finds each linked edge again and `followLinks`
 * moves the copy to it, so the sketch follows the part.
 *
 * All positions are sketch millimetres.
 */
import { sameRef, type EdgeRef, type TopoPick, type Vec3 } from "../geometry/topoRef";
import { pointPos, settle, sketchId, type EditResult } from "./ops";
import { toSketch, type PlaneFrame, type SketchPlane } from "./planes";
import type { CurveLink, SketchArc, SketchCircle, SketchConstraint, SketchCurve, SketchData, SketchLine, SketchPoint } from "./types";

type P2 = [number, number];

/** A part edge as seen in the sketch's plane. */
export interface RefEdge {
  /** The edge (on its part), so it can be found again after a rebuild. */
  pick: TopoPick;
  /** Straight, a whole circle, part of a circle, or some other curve (shown and snapped to its ends only). */
  kind: "line" | "circle" | "arc" | "curve";
  a: P2;
  b: P2;
  mid: P2;
  centre?: P2;
  radius?: number;
  /** An arc's ends, anticlockwise (start, end). */
  start?: P2;
  end?: P2;
  /** Other curves: points along it. */
  path?: P2[];
}

/** What the geometry engine found for a sketch's links on the latest rebuild. */
export interface SketchLinkInfo {
  /** Edges of the face the sketch is on (empty when it isn't on a part's face). */
  edges: RefEdge[];
  /** For each linked curve: where its edge is now, or null when it can't be found. */
  links: Record<string, RefEdge | null>;
  /** The sketch's plane, moved to where its face is now (only when the face has moved). */
  plane?: SketchPlane;
  /** The face the sketch was put on can't be found any more. */
  faceLost?: boolean;
  /** The sketch as the engine used it (plane and data), when following the part changed it. */
  sketch?: { plane: SketchPlane; data: SketchData };
}

const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

function circleCentre(a: P2, b: P2, c: P2): P2 | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

/**
 * A part edge seen in a sketch: its ends, middle and (for round edges) centre
 * and radius, in sketch mm. Null when the edge isn't flat to the sketch (it
 * would be squashed seeing it end-on). `samples`: points along other curves.
 */
export function projectEdge(frame: PlaneFrame, pick: TopoPick, samples?: Vec3[]): RefEdge | null {
  const ref = pick.ref as EdgeRef;
  if (ref.kind !== "edge") return null;
  const height = (p: Vec3) => (p[0] - frame.origin[0]) * frame.n[0] + (p[1] - frame.origin[1]) * frame.n[1] + (p[2] - frame.origin[2]) * frame.n[2];
  const h0 = height(ref.mid);
  // Edge ends are kept to 0.1 µm, so on a sloping face they can be that far off the plane.
  if ([ref.a, ref.b, ...(samples ?? [])].some((p) => Math.abs(height(p) - h0) > 1e-3)) return null;
  const a = toSketch(frame, ref.a);
  const b = toSketch(frame, ref.b);
  const mid = toSketch(frame, ref.mid);
  if (ref.curve === "LINE") return dist(a, b) < 1e-6 ? null : { pick, kind: "line", a, b, mid };
  if (ref.curve === "CIRCLE") {
    const full = Math.hypot(ref.a[0] - ref.b[0], ref.a[1] - ref.b[1], ref.a[2] - ref.b[2]) < 1e-6;
    const centre = full ? ([(a[0] + mid[0]) / 2, (a[1] + mid[1]) / 2] as P2) : circleCentre(a, mid, b);
    if (!centre) return null;
    const radius = dist(a, centre);
    if (radius < 1e-6) return null;
    if (full) return { pick, kind: "circle", a, b, mid, centre, radius };
    const ang = (p: P2) => norm(Math.atan2(p[1] - centre[1], p[0] - centre[0]));
    const anticlockwise = norm(ang(mid) - ang(a)) < norm(ang(b) - ang(a));
    return { pick, kind: "arc", a, b, mid, centre, radius, start: anticlockwise ? a : b, end: anticlockwise ? b : a };
  }
  const path = samples?.length ? samples.map((p) => toSketch(frame, p)) : [a, mid, b];
  return { pick, kind: "curve", a, b, mid, path };
}

// ---------------------------------------------------------------------------
// Reference edges as stand-in sketch geometry (for drawing, hovering and snapping)

/** Ids of the stand-in geometry start with this; they're never stored in a sketch. */
export const REF_PREFIX = "ref:";
export const isRefId = (id: string) => id.startsWith(REF_PREFIX);

/** Which edge a stand-in id belongs to, and what part of it: an end (a, b), the centre (c), a point along a curve (q), or the edge itself. */
export function parseRefId(id: string): { index: number; what: "a" | "b" | "c" | "q" | "edge" } | null {
  const m = /^ref:(\d+)(?::([abcqs])\d*)?$/.exec(id);
  if (!m) return null;
  const what = m[2] === undefined || m[2] === "s" ? "edge" : (m[2] as "a" | "b" | "c" | "q");
  return { index: Number(m[1]), what };
}

/**
 * The reference edges as sketch geometry (ids "ref:<n>", its ends "ref:<n>:a"
 * and ":b", a round edge's centre ":c"), so they can be drawn, hovered and
 * snapped to like the sketch's own lines.
 */
export function refSketch(edges: RefEdge[]): SketchData {
  const points: SketchPoint[] = [];
  const curves: SketchCurve[] = [];
  edges.forEach((e, i) => {
    const id = `${REF_PREFIX}${i}`;
    const pt = (suffix: string, p: P2) => {
      points.push({ id: `${id}:${suffix}`, x: p[0], y: p[1] });
      return `${id}:${suffix}`;
    };
    if (e.kind === "line") curves.push({ id, type: "line", p1: pt("a", e.a), p2: pt("b", e.b), construction: false });
    else if (e.kind === "circle") curves.push({ id, type: "circle", center: pt("c", e.centre!), radius: e.radius!, construction: false });
    else if (e.kind === "arc") {
      const startIsA = dist(e.start!, e.a) < 1e-9;
      const a = pt("a", e.a), b = pt("b", e.b);
      curves.push({ id, type: "arc", center: pt("c", e.centre!), start: startIsA ? a : b, end: startIsA ? b : a, construction: false });
    } else {
      const path = e.path ?? [e.a, e.mid, e.b];
      const ids = path.map((p, k) => (k === 0 ? pt("a", p) : k === path.length - 1 ? pt("b", p) : pt(`q${k}`, p)));
      for (let k = 0; k + 1 < ids.length; k++) curves.push({ id: `${id}:s${k}`, type: "line", p1: ids[k], p2: ids[k + 1], construction: false });
    }
  });
  return { points, curves, constraints: [] };
}

// ---------------------------------------------------------------------------
// Copying an edge in, linked

/** The sketch curve already following this edge, if any. */
export function linkedCurveFor(s: SketchData, pick: TopoPick): SketchCurve | undefined {
  return s.curves.find((c) => "link" in c && c.link && c.link.partId === pick.partId && sameRef(c.link.ref, pick.ref));
}

/** The points of a linked curve that sit on its edge's ends (a, b) and centre (c). */
function pointsOn(s: SketchData, c: SketchCurve, e: RefEdge): { a?: string; b?: string; c?: string } {
  if (c.type === "line") {
    const p1 = pointPos(s, c.p1);
    return dist(p1, e.a) <= dist(p1, e.b) ? { a: c.p1, b: c.p2 } : { a: c.p2, b: c.p1 };
  }
  if (c.type === "circle") return { c: c.center };
  if (c.type === "arc") {
    const st = pointPos(s, c.start);
    return dist(st, e.a) <= dist(st, e.b) ? { a: c.start, b: c.end, c: c.center } : { a: c.end, b: c.start, c: c.center };
  }
  return {};
}

const fixAt = (id: string, p: P2): SketchConstraint => ({ id: sketchId("c"), type: "fix", refs: [id], extra: [p[0], p[1]] });

/**
 * Bring a part edge into the sketch, following the edge: as a reference
 * (construction) for snapping and dimensioning, or as real geometry ("Use").
 * An edge already in the sketch is reused (and made real if asked).
 * Returns the curve and the points on its ends and centre.
 */
export function linkEdge(
  s: SketchData,
  edge: RefEdge,
  construction: boolean,
  cut?: CurveLink["cut"],
): EditResult & { curveId: string; points: { a?: string; b?: string; c?: string } } {
  const known = linkedCurveFor(s, edge.pick);
  if (known) {
    const sketch = !construction && known.construction ? { ...s, curves: s.curves.map((c) => (c === known ? { ...c, construction: false } : c)) } : s;
    return { sketch, curveId: known.id, points: pointsOn(s, known, edge) };
  }
  if (edge.kind === "curve") return { sketch: s, curveId: "", points: {}, error: "Only straight and round edges can be used in a sketch for now. Snap to its ends instead." };
  const pt = (p: P2): SketchPoint => ({ id: sketchId("p"), x: p[0], y: p[1] });
  const link: CurveLink = { partId: edge.pick.partId, ref: edge.pick.ref, ...(cut ? { cut } : {}) };
  const points: SketchPoint[] = [];
  const constraints: SketchConstraint[] = [];
  let curve: SketchCurve;
  let ids: { a?: string; b?: string; c?: string };
  if (edge.kind === "line") {
    const [pa, pb] = [pt(edge.a), pt(edge.b)];
    points.push(pa, pb);
    constraints.push(fixAt(pa.id, edge.a), fixAt(pb.id, edge.b));
    curve = { id: sketchId("l"), type: "line", p1: pa.id, p2: pb.id, construction, link } satisfies SketchLine;
    ids = { a: pa.id, b: pb.id };
  } else if (edge.kind === "circle") {
    const c = pt(edge.centre!);
    // A point on the rim holds the size (it's fixed too).
    const rim = pt([edge.centre![0] + edge.radius!, edge.centre![1]]);
    const id = sketchId("k");
    points.push(c, rim);
    constraints.push(fixAt(c.id, edge.centre!), fixAt(rim.id, [rim.x, rim.y]), { id: sketchId("c"), type: "pointOnCircle", refs: [rim.id, id] });
    curve = { id, type: "circle", center: c.id, radius: edge.radius!, construction, link } satisfies SketchCircle;
    ids = { c: c.id };
  } else {
    const c = pt(edge.centre!);
    const [pa, pb] = [pt(edge.a), pt(edge.b)];
    points.push(c, pa, pb);
    constraints.push(fixAt(c.id, edge.centre!), fixAt(pa.id, edge.a), fixAt(pb.id, edge.b));
    const startIsA = dist(edge.start!, edge.a) < 1e-9;
    curve = { id: sketchId("a"), type: "arc", center: c.id, start: startIsA ? pa.id : pb.id, end: startIsA ? pb.id : pa.id, construction, link } satisfies SketchArc;
    ids = { a: pa.id, b: pb.id, c: c.id };
  }
  const r = settle({ points: [...s.points, ...points], curves: [...s.curves, curve], constraints: [...s.constraints, ...constraints] });
  return { ...r, curveId: curve.id, points: ids };
}

/** Use every edge of the face (as real geometry). Edges that can't be used are skipped. */
export function linkAllEdges(s: SketchData, edges: RefEdge[]): EditResult & { curveIds: string[] } {
  let sketch = s;
  const curveIds: string[] = [];
  for (const e of edges) {
    const r = linkEdge(sketch, e, false);
    if (r.error) continue;
    sketch = r.sketch;
    curveIds.push(r.curveId);
  }
  if (!curveIds.length) return { sketch: s, curveIds, error: "None of this face's edges can be used (only straight and round edges can)." };
  // Edges meeting at a corner share the corner point, so the outline is closed and can be extruded.
  return { sketch: joinTouchingEnds(sketch, curveIds), curveIds };
}

/** Merge the end points of these curves that sit on top of each other (all fixed in the same place). */
function joinTouchingEnds(s: SketchData, curveIds: string[]): SketchData {
  const ids = new Set(curveIds);
  const ends: string[] = [];
  for (const c of s.curves) {
    if (!ids.has(c.id)) continue;
    if (c.type === "line") ends.push(c.p1, c.p2);
    else if (c.type === "arc") ends.push(c.start, c.end);
  }
  const keep = new Map<string, string>();
  const kept: string[] = [];
  for (const id of ends) {
    if (keep.has(id)) continue;
    const p = pointPos(s, id);
    const same = kept.find((k) => dist(pointPos(s, k), p) < 1e-6);
    keep.set(id, same ?? id);
    if (!same) kept.push(id);
  }
  const to = (id: string) => keep.get(id) ?? id;
  const gone = new Set([...keep].filter(([a, b]) => a !== b).map(([a]) => a));
  if (!gone.size) return s;
  return {
    ...s,
    points: s.points.filter((p) => !gone.has(p.id)),
    curves: s.curves.map((c) => (c.type === "line" ? { ...c, p1: to(c.p1), p2: to(c.p2) } : c.type === "arc" ? { ...c, start: to(c.start), end: to(c.end) } : c)),
    // The merged points' own fixes go (the kept point is fixed in the same place).
    constraints: s.constraints.filter((k) => !(k.type === "fix" && gone.has(k.refs[0]))),
  };
}

// ---------------------------------------------------------------------------
// Following the part

/** Points of linked curves (their fixes are part of the link, so they're not shown as anchors). */
export function linkedPoints(s: SketchData): Set<string> {
  const out = new Set<string>();
  for (const c of s.curves) {
    if (!("link" in c) || !c.link) continue;
    if (c.type === "line") out.add(c.p1).add(c.p2);
    else if (c.type === "circle") {
      out.add(c.center);
      for (const k of s.constraints) if (k.type === "pointOnCircle" && k.refs[1] === c.id) out.add(k.refs[0]);
    } else if (c.type === "arc") out.add(c.center).add(c.start).add(c.end);
  }
  return out;
}

/**
 * Move each linked curve to where its edge is now (`links`: from the
 * geometry engine; null = the edge has gone, so the curve stays put) and
 * re-solve, so anything constrained to it follows. Returns the same sketch
 * when nothing moved.
 */
export function followLinks(s: SketchData, links: Record<string, RefEdge | null | undefined>): SketchData {
  const moves = new Map<string, P2>();
  const radii = new Map<string, number>();
  for (const c of s.curves) {
    if (!("link" in c) || !c.link) continue;
    const e = links[c.id];
    if (!e) continue;
    if (c.type === "line" && e.kind === "line") {
      // Keep the line running the same way.
      const was = sub(pointPos(s, c.p2), pointPos(s, c.p1));
      const now = sub(e.b, e.a);
      const same = was[0] * now[0] + was[1] * now[1] >= 0;
      moves.set(c.p1, same ? e.a : e.b);
      moves.set(c.p2, same ? e.b : e.a);
    } else if (c.type === "circle" && e.kind === "circle") {
      const oldC = pointPos(s, c.center);
      moves.set(c.center, e.centre!);
      radii.set(c.id, e.radius!);
      for (const k of s.constraints) {
        if (k.type !== "pointOnCircle" || k.refs[1] !== c.id) continue;
        const rim = pointPos(s, k.refs[0]);
        const ang = Math.atan2(rim[1] - oldC[1], rim[0] - oldC[0]);
        moves.set(k.refs[0], [e.centre![0] + e.radius! * Math.cos(ang), e.centre![1] + e.radius! * Math.sin(ang)]);
      }
    } else if (c.type === "arc" && e.kind === "arc") {
      moves.set(c.center, e.centre!);
      moves.set(c.start, e.start!);
      moves.set(c.end, e.end!);
    }
  }
  let moved = false;
  for (const [id, p] of moves) if (dist(pointPos(s, id), p) > 1e-9) moved = true;
  for (const c of s.curves) if (c.type === "circle" && radii.has(c.id) && Math.abs(radii.get(c.id)! - c.radius) > 1e-9) moved = true;
  if (!moved) return s;
  const data: SketchData = {
    // Texts and pictures (and anything else the sketch holds) stay as they are.
    ...s,
    points: s.points.map((p) => {
      const to = moves.get(p.id);
      return to ? { ...p, x: to[0], y: to[1] } : p;
    }),
    curves: s.curves.map((c) => (c.type === "circle" && radii.has(c.id) ? { ...c, radius: radii.get(c.id)! } : c)),
    constraints: s.constraints.map((k) => {
      const to = k.type === "fix" ? moves.get(k.refs[0]) : undefined;
      return to ? { ...k, extra: [to[0], to[1]] } : k;
    }),
  };
  return settle(data).sketch;
}

/** A plain-English note about linked edges that can't be found, or null when all is well. */
export function lostLinksMessage(s: SketchData, info: SketchLinkInfo | undefined): string | null {
  if (!info) return null;
  const lost = s.curves.filter((c) => "link" in c && c.link && info.links[c.id] === null).length;
  const parts: string[] = [];
  if (info.faceLost) parts.push("The face this sketch is on can't be found on the part any more, so its edges aren't shown and the sketch stays where it was. Pick the face again to put it back on the part.");
  if (lost)
    parts.push(
      `${lost === 1 ? "1 edge" : `${lost} edges`} this sketch uses ${lost === 1 ? "has" : "have"} gone from the part, so ${lost === 1 ? "it stays" : "they stay"} where ${lost === 1 ? "it was" : "they were"}. Delete ${lost === 1 ? "it" : "them"}, or use another edge.`,
    );
  return parts.length ? parts.join(" ") : null;
}

/** What to say on the sketch in the feature list when its face or edges can't be found, or null. */
export function linkProblem(info: SketchLinkInfo | undefined): string | null {
  if (!info) return null;
  const lost = Object.values(info.links).filter((e) => e === null).length;
  if (info.faceLost)
    return "The face this sketch was on can't be found any more (the part has changed too much), so the sketch stays where it was. Edit the sketch and click Pick the face again.";
  if (lost)
    return `${lost === 1 ? "A part edge" : `${lost} part edges`} this sketch uses can't be found any more, so ${lost === 1 ? "its copy stays" : "their copies stay"} where ${lost === 1 ? "it was" : "they were"}. Edit the sketch and delete ${lost === 1 ? "it" : "them"} (shown in the sketch panel), or use other edges.`;
  return null;
}

/**
 * Drop part edges brought in only as references (construction, following an
 * edge) that nothing uses: no other line, arc or circle shares their points and
 * no constraint or dimension refers to them, apart from those holding them on
 * their edge. Returns the same sketch when there's nothing to drop.
 */
export function pruneReferences(s: SketchData): SketchData {
  const gone = new Set<string>();
  for (const c of s.curves) {
    // Intersect's curves were asked for, so they stay.
    if (!("link" in c) || !c.link || !c.construction || c.link.cut) continue;
    const own = new Set<string>(c.type === "line" ? [c.p1, c.p2] : c.type === "circle" ? [c.center] : c.type === "arc" ? [c.center, c.start, c.end] : []);
    // A circle's rim point holds its size: it's its own.
    for (const k of s.constraints) if (k.type === "pointOnCircle" && k.refs[1] === c.id && k.refs.length === 2) own.add(k.refs[0]);
    const holding = (k: SketchConstraint) => (k.type === "fix" && own.has(k.refs[0])) || (k.type === "pointOnCircle" && k.refs[1] === c.id && own.has(k.refs[0]));
    const usedByConstraint = s.constraints.some((k) => !holding(k) && k.refs.some((r) => r === c.id || own.has(r)));
    const sharesPoint = s.curves.some((o) => o !== c && curvePointsOf(o).some((p) => own.has(p)));
    if (!usedByConstraint && !sharesPoint) gone.add(c.id);
  }
  if (!gone.size) return s;
  const curves = s.curves.filter((c) => !gone.has(c.id));
  const kept = new Set(curves.flatMap(curvePointsOf));
  const points = s.points.filter((p) => kept.has(p.id) || (p.standalone && !s.constraints.some((k) => k.type === "pointOnCircle" && gone.has(k.refs[1]) && k.refs[0] === p.id)));
  const alive = new Set(["origin", ...points.map((p) => p.id), ...curves.map((c) => c.id)]);
  return { ...s, points, curves, constraints: s.constraints.filter((k) => k.refs.every((r) => alive.has(r))) };
}

const curvePointsOf = (c: SketchCurve): string[] =>
  c.type === "line" ? [c.p1, c.p2] : c.type === "circle" ? [c.center] : c.type === "spline" ? c.points : c.type === "ellipse" ? [c.center, c.major, c.minor, ...(c.start && c.end ? [c.start, c.end] : [])] : [c.center, c.start, c.end];
