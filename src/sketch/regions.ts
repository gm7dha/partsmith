/**
 * Finds the closed shapes in a sketch, ready to extrude.
 *
 * Solid (non-construction) lines and arcs are joined end to end into loops;
 * circles are loops on their own. A loop inside another loop becomes a hole;
 * a loop inside a hole becomes an island, and so on (even–odd nesting).
 *
 * Shapes that cross each other aren't split up here (overlapping shapes are
 * joined; see nestLoops). To use the separate areas where curves cross, a
 * feature stores the areas the user clicked: see `areas.ts`.
 */
import { ellipseFrom, ellipsePolyline } from "./ellipse";
import { reversedHandles, splineBeziers, splinePolyline } from "./spline";
import { ORIGIN_ID, type SketchCurve, type SketchData } from "./types";
import { splineHandles, splineHandlesIn } from "./ops";
import { ellipseSpan } from "./curves";
import { ellipseAt } from "./ellipse";
import { textContours, textsOf } from "./sketchText";

export type Pt = [number, number];

/** One piece of a loop's outline, in order around the loop. */
export type Segment =
  | { kind: "line"; from: Pt; to: Pt }
  | { kind: "arc"; from: Pt; mid: Pt; to: Pt }
  | { kind: "circle"; center: Pt; radius: number }
  /** A piece of a spline: a cubic Bézier curve. */
  | { kind: "bezier"; from: Pt; c1: Pt; c2: Pt; to: Pt }
  /** A whole ellipse: half-lengths along its turned x and y axes. */
  | { kind: "ellipse"; center: Pt; rx: number; ry: number; angle: number }
  /**
   * Part of an ellipse (only from areas the user picked, where curves cut an
   * ellipse): anticlockwise from parameter t0 to t1 (t0 < t1, radians; a point
   * is centre + rx·cos t along the turned x axis + ry·sin t along its y axis).
   * `from`/`to` are its ends in the order the loop walks them.
   */
  | { kind: "ellipseArc"; center: Pt; rx: number; ry: number; angle: number; t0: number; t1: number; from: Pt; to: Pt };

export interface Loop {
  segments: Segment[];
  /** Polygon approximation (anticlockwise), for area and inside tests. */
  polygon: Pt[];
  area: number;
}

/** An outer loop and the loops cut out of it. */
export interface Region {
  outer: Loop;
  holes: Loop[];
}

export interface RegionResult {
  regions: Region[];
  /** Plain-English notes about shapes that couldn't be used. */
  problems: string[];
}

const pointsById = (s: SketchData) => {
  const m = new Map<string, Pt>(s.points.map((p) => [p.id, [p.x, p.y]]));
  m.set(ORIGIN_ID, [0, 0]);
  return m;
};

function arcGeometry(center: Pt, start: Pt, end: Pt) {
  const r = Math.hypot(start[0] - center[0], start[1] - center[1]);
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  let a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
  while (a1 <= a0) a1 += 2 * Math.PI;
  return { r, a0, a1 };
}

/** Sample points along a curve from one end to the other (excluding the final point). */
function sampleArc(center: Pt, r: number, from: number, to: number, out: Pt[]) {
  const steps = Math.max(8, Math.ceil(Math.abs(to - from) / (Math.PI / 36)));
  for (let i = 0; i < steps; i++) {
    const a = from + ((to - from) * i) / steps;
    out.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
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

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Is `p` within `eps` of a closed polygon's outline ("edge"), else inside it or
 * outside? The same answer as measuring the distance to the outline, then `pointInPolygon`, in one
 * pass and without square roots (this runs for every sample of every loop).
 */
function placeAgainst(p: Pt, poly: Pt[], eps: number): "edge" | "in" | "out" {
  const [px, py] = p;
  const e2 = eps * eps;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], ay = poly[j][1];
    const bx = poly[i][0], by = poly[i][1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    const ex = ax + t * dx - px, ey = ay + t * dy - py;
    if (ex * ex + ey * ey <= e2) return "edge";
    if (by > py !== ay > py && px < ((ax - bx) * (py - by)) / (ay - by) + bx) inside = !inside;
  }
  return inside ? "in" : "out";
}

/** Do two outlines properly cross each other somewhere (not just touch)? */
function outlinesCross(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const p = a[i], p2 = a[(i + 1) % a.length];
    const r: Pt = [p2[0] - p[0], p2[1] - p[1]];
    for (let j = 0; j < b.length; j++) {
      const q = b[j], q2 = b[(j + 1) % b.length];
      const w: Pt = [q2[0] - q[0], q2[1] - q[1]];
      const den = r[0] * w[1] - r[1] * w[0];
      if (Math.abs(den) < 1e-12) continue;
      const qp: Pt = [q[0] - p[0], q[1] - p[1]];
      const t = (qp[0] * w[1] - qp[1] * w[0]) / den;
      const u = (qp[0] * r[1] - qp[1] * r[0]) / den;
      if (t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6) return true;
    }
  }
  return false;
}

function makeLoop(segments: Segment[], polygon: Pt[]): Loop {
  let area = signedArea(polygon);
  if (area < 0) {
    polygon.reverse();
    area = -area;
  }
  return { segments, polygon, area };
}

/** The sketch's curves as a graph: the standalone closed curves, and the end-to-end curves between shared points. */
function sketchGraph(sketch: SketchData) {
  const pts = pointsById(sketch);
  const loops: Loop[] = [];
  const solid = sketch.curves.filter((c) => !c.construction);

  // Circles are complete loops by themselves.
  for (const c of solid) {
    if (c.type !== "circle") continue;
    const center = pts.get(c.center)!;
    if (c.radius <= 1e-9) continue;
    const poly: Pt[] = [];
    sampleArc(center, c.radius, 0, 2 * Math.PI, poly);
    loops.push(makeLoop([{ kind: "circle", center, radius: c.radius }], poly));
  }

  // So are ellipses.
  for (const c of solid) {
    if (c.type !== "ellipse" || (c.start && c.end)) continue;
    const g = ellipseFrom(pts.get(c.center)!, pts.get(c.major)!, pts.get(c.minor)!);
    if (g.rx <= 1e-9 || g.ry <= 1e-9) continue;
    loops.push(makeLoop([{ kind: "ellipse", center: g.centre, rx: g.rx, ry: g.ry, angle: g.angle }], ellipsePolyline(g).slice(0, -1)));
  }

  // Closed splines are complete loops by themselves too.
  for (const c of solid) {
    if (c.type !== "spline" || !c.closed || c.points.length < 3) continue;
    const ps = c.points.map((id) => pts.get(id)!);
    const hs = splineHandles(c);
    const hi = splineHandlesIn(c);
    const segs: Segment[] = splineBeziers(ps, true, undefined, hs, hi).map(([from, c1, c2, to]) => ({ kind: "bezier", from, c1, c2, to }));
    loops.push(makeLoop(segs, splinePolyline(ps, true, undefined, undefined, hs, hi)));
  }

  // Each letter outline of a text is a loop too (holes such as the inside of an "o" nest as usual).
  for (const t of textsOf(sketch)) {
    if (t.construction) continue;
    for (const c of textContours(sketch, t)) {
      const segs: Segment[] = c.map((p, i) => ({ kind: "line", from: p, to: c[(i + 1) % c.length] }));
      const loop = makeLoop(segs, [...c]);
      if (loop.area > 1e-9) loops.push(loop);
    }
  }

  // Join lines, arcs and open splines at shared end points (merged by position, so separate
  // but coincident points count as joined).
  const ends = solid.filter(
    (c): c is Exclude<SketchCurve, { type: "circle" }> =>
      c.type !== "circle" && !(c.type === "ellipse" && !(c.start && c.end)) && !(c.type === "spline" && (c.closed || c.points.length < 2)),
  );
  const keyOf = (p: Pt) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const nodeOf = new Map<string, number>();
  const nodePos: Pt[] = [];
  const node = (p: Pt) => {
    const k = keyOf(p);
    let i = nodeOf.get(k);
    if (i === undefined) {
      i = nodePos.length;
      nodeOf.set(k, i);
      nodePos.push(p);
    }
    return i;
  };
  interface GraphEdge {
    curve: (typeof ends)[number];
    a: number;
    b: number;
  }
  const edges: GraphEdge[] = [];
  for (const c of ends) {
    const [p, q] =
      c.type === "line"
        ? [pts.get(c.p1)!, pts.get(c.p2)!]
        : c.type === "spline"
          ? [pts.get(c.points[0])!, pts.get(c.points[c.points.length - 1])!]
          : [pts.get(c.start!)!, pts.get(c.end!)!];
    const a = node(p);
    const b = node(q);
    if (a === b) continue; // zero-length
    edges.push({ curve: c, a, b });
  }
  const adjacency = new Map<number, number[]>();
  edges.forEach((e, i) => {
    for (const n of [e.a, e.b]) adjacency.set(n, [...(adjacency.get(n) ?? []), i]);
  });

  /** One curve walked from node `at`: its pieces and polygon points (the polygon leaves out the end point). */
  const walkEdge = (ei: number, at: number): { segments: Segment[]; polygon: Pt[]; next: number } => {
    const e = edges[ei];
    const forward = e.a === at;
    const next = forward ? e.b : e.a;
    const from = nodePos[at];
    const to = nodePos[next];
    const segments: Segment[] = [];
    const polygon: Pt[] = [];
    if (e.curve.type === "line") {
      segments.push({ kind: "line", from, to });
      polygon.push(from);
    } else if (e.curve.type === "spline") {
      // Its pieces, the other way round when walking it backwards.
      const ps = e.curve.points.map((id) => pts.get(id)!);
      // Walked backwards, each handle points the other way too.
      const h = forward ? { tangents: splineHandles(e.curve), tangentsIn: splineHandlesIn(e.curve) } : reversedHandles(splineHandles(e.curve), splineHandlesIn(e.curve));
      const pieces = splineBeziers(forward ? ps : [...ps].reverse(), false, e.curve.conic, h.tangents, h.tangentsIn);
      for (const [f, c1, c2, t] of pieces) segments.push({ kind: "bezier", from: f, c1, c2, to: t });
      polygon.push(...splinePolyline(forward ? ps : [...ps].reverse(), false, undefined, e.curve.conic, h.tangents, h.tangentsIn).slice(0, -1));
    } else if (e.curve.type === "ellipse") {
      // Part of an ellipse, anticlockwise from its start to its end (walked either way).
      const { g, t0, t1 } = ellipseSpan(sketch, e.curve);
      segments.push({ kind: "ellipseArc", center: g.centre, rx: g.rx, ry: g.ry, angle: g.angle, t0, t1, from, to });
      const n = Math.max(8, Math.ceil((t1 - t0) / (Math.PI / 36)));
      for (let i = 0; i < n; i++) polygon.push(ellipseAt(g, forward ? t0 + ((t1 - t0) * i) / n : t1 - ((t1 - t0) * i) / n));
    } else {
      const center = pts.get(e.curve.center)!;
      const s = pts.get(e.curve.start)!;
      const en = pts.get(e.curve.end)!;
      const { r, a0, a1 } = arcGeometry(center, s, en);
      const midA = (a0 + a1) / 2;
      const mid: Pt = [center[0] + r * Math.cos(midA), center[1] + r * Math.sin(midA)];
      segments.push({ kind: "arc", from, mid, to });
      if (forward) sampleArc(center, r, a0, a1, polygon);
      else sampleArc(center, r, a1, a0, polygon);
    }
    return { segments, polygon, next };
  };

  // The connected groups of curves: closed rings, open runs, or branching (a junction of three or more).
  const usedEdge = new Array<boolean>(edges.length).fill(false);
  const groups: { edges: number[]; kind: "closed" | "open" | "branching" }[] = [];
  for (let start = 0; start < edges.length; start++) {
    if (usedEdge[start]) continue;
    const group: number[] = [];
    const stack = [start];
    usedEdge[start] = true;
    while (stack.length) {
      const ei = stack.pop()!;
      group.push(ei);
      for (const n of [edges[ei].a, edges[ei].b]) {
        for (const nb of adjacency.get(n) ?? []) {
          if (!usedEdge[nb]) {
            usedEdge[nb] = true;
            stack.push(nb);
          }
        }
      }
    }
    const nodes = new Set(group.flatMap((ei) => [edges[ei].a, edges[ei].b]));
    const degrees = [...nodes].map((n) => (adjacency.get(n) ?? []).length);
    groups.push({ edges: group, kind: degrees.some((d) => d > 2) ? "branching" : degrees.some((d) => d < 2) ? "open" : "closed" });
  }

  /** Walk a ring or run from `at` along its curves, in order. */
  const walk = (group: number[], first: number, at: number): { segments: Segment[]; polygon: Pt[] } => {
    const segments: Segment[] = [];
    const polygon: Pt[] = [];
    const visited = new Set<number>();
    let current = first;
    while (!visited.has(current)) {
      visited.add(current);
      const step = walkEdge(current, at);
      segments.push(...step.segments);
      polygon.push(...step.polygon);
      at = step.next;
      const after = (adjacency.get(at) ?? []).find((ei) => ei !== current && !visited.has(ei) && group.includes(ei));
      if (after === undefined) break;
      current = after;
    }
    return { segments, polygon, end: nodePos[at] } as { segments: Segment[]; polygon: Pt[] } & { end: Pt };
  };

  return { loops, edges, nodePos, adjacency, groups, walk };
}

/** A run of curves joined end to end: a closed ring, or open with two free ends. */
export interface Chain {
  segments: Segment[];
  closed: boolean;
}

/**
 * Every run of the sketch's (non-construction) curves, closed or open, each
 * walked in order — for surfaces, which can be made from open outlines too.
 * Runs with a junction of three or more curves are left out.
 */
export function findChains(sketch: SketchData): { chains: Chain[]; problems: string[] } {
  const g = sketchGraph(sketch);
  const chains: Chain[] = g.loops.map((l) => ({ segments: l.segments, closed: true }));
  let branching = 0;
  for (const group of g.groups) {
    if (group.kind === "branching") {
      branching++;
      continue;
    }
    const first = group.kind === "open" ? group.edges.find((ei) => [g.edges[ei].a, g.edges[ei].b].some((n) => (g.adjacency.get(n) ?? []).length === 1))! : group.edges[0];
    const e = g.edges[first];
    const at = group.kind === "open" && (g.adjacency.get(e.b) ?? []).length === 1 ? e.b : e.a;
    const { segments } = g.walk(group.edges, first, at);
    chains.push({ segments, closed: group.kind === "closed" });
  }
  const problems: string[] = [];
  if (branching) problems.push(`${branching} shape${branching > 1 ? "s have" : " has"} lines meeting at a junction, so ${branching > 1 ? "they were" : "it was"} left out.`);
  return { chains, problems };
}

export function findRegions(sketch: SketchData): RegionResult {
  const g = sketchGraph(sketch);
  const problems: string[] = [];
  const loops: Loop[] = [...g.loops];
  let openShapes = 0;
  let branching = 0;
  for (const group of g.groups) {
    if (group.kind === "branching") {
      branching++;
      continue;
    }
    if (group.kind === "open") {
      openShapes++;
      continue;
    }
    const { segments, polygon } = g.walk(group.edges, group.edges[0], g.edges[group.edges[0]].a);
    const loop = makeLoop(segments, polygon);
    if (loop.area > 1e-9) loops.push(loop);
  }

  if (openShapes) problems.push(`${openShapes} shape${openShapes > 1 ? "s aren't" : " isn't"} closed, so ${openShapes > 1 ? "they were" : "it was"} left out.`);
  if (branching)
    problems.push(
      `${branching} shape${branching > 1 ? "s have" : " has"} lines meeting at a junction, so ${branching > 1 ? "they were" : "it was"} left out. To use the areas between those lines, click them in the Extrude, Revolve or Sweep dialog.`,
    );

  return { regions: nestLoops(loops), problems };
}

type Box = [number, number, number, number];
const boxOf = (poly: Pt[]): Box => {
  const b: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of poly) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  return b;
};
const boxesMeet = (a: Box, b: Box, eps: number) => a[0] <= b[2] + eps && b[0] <= a[2] + eps && a[1] <= b[3] + eps && b[1] <= a[3] + eps;

/** Points round a loop's outline, to judge where it sits: its corners and quarter points along each side. */
function samplesOf(loop: Loop): Pt[] {
  const poly = loop.polygon;
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    for (const t of [0, 0.25, 0.5, 0.75]) out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/**
 * Sort closed loops into solid shapes and the holes in them.
 *
 * Loops are taken biggest first. A loop lying within the shapes already seen
 * that it touches (judged from points round its outline; points right on their
 * edges don't count either way) nests inside them. One that is only partly
 * inside (two shapes overlapping) is joined to them as one group instead, so
 * they stay solid together. Depth is how many groups a loop nests in: even =
 * solid, odd = a hole, cut from every shape in the group around it.
 */
function nestLoops(loops: Loop[]): Region[] {
  const n = loops.length;
  if (!n) return [];
  const boxes = loops.map((l) => boxOf(l.polygon));
  const size = Math.max(1, ...boxes.map((b) => Math.max(Math.abs(b[0]), Math.abs(b[1]), Math.abs(b[2]), Math.abs(b[3]))));
  const eps = 1e-6 * size;
  const order = loops.map((_l, i) => i).sort((i, j) => loops[j].area - loops[i].area);
  const samples: (Pt[] | null)[] = loops.map(() => null);
  const samplesFor = (i: number) => (samples[i] ??= samplesOf(loops[i]));

  /**
   * Where loop `i`'s outline sits against the loops `others` (taken together):
   * how many sample points are inside one of them, and how many are outside all.
   */
  const tallies = new Map<string, { inside: number; outside: number }>();
  const tally = (i: number, others: number[]) => {
    // The same question is often asked again (nesting, then depth): answer it once.
    const key = `${i}:${others.join(",")}`;
    let t = tallies.get(key);
    if (!t) tallies.set(key, (t = countAgainst(i, others)));
    return t;
  };
  const countAgainst = (i: number, others: number[]) => {
    let inside = 0;
    let outside = 0;
    for (const p of samplesFor(i)) {
      let isIn = false;
      let onEdge = false;
      for (const j of others) {
        const b = boxes[j];
        if (p[0] < b[0] - eps || p[0] > b[2] + eps || p[1] < b[1] - eps || p[1] > b[3] + eps) continue;
        const where = placeAgainst(p, loops[j].polygon, eps);
        if (where === "edge") onEdge = true;
        else if (where === "in") {
          isIn = true;
          break;
        }
      }
      if (isIn) inside++;
      else if (!onEdge) outside++;
    }
    return { inside, outside };
  };
  // Nearly all inside: a circle drawn as straight pieces can poke out a hair where it touches a side.
  const within = (t: { inside: number; outside: number }) => t.inside > 0 && t.outside <= 0.05 * (t.inside + t.outside);

  const group = loops.map((_l, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
  /** For each loop, the bigger loops its outline touches or is inside. */
  const touching: number[][] = loops.map(() => []);
  const seen: number[] = [];
  for (const i of order) {
    // Only bigger loops whose boxes meet this one's can hold or overlap it.
    const near = seen.filter((j) => boxesMeet(boxes[i], boxes[j], eps));
    const related = near.filter((j) => {
      const t = tally(i, [j]);
      if (t.inside > 0) return true;
      // No sample lands inside, but the outlines may still cross (two thin bars).
      return outlinesCross(loops[i].polygon, loops[j].polygon);
    });
    touching[i] = related;
    // Within the shapes it touches (even across where two of them overlap): it nests. Otherwise it joins them.
    if (related.length && !within(tally(i, related))) for (const j of related) group[find(i)] = find(j);
    seen.push(i);
  }

  // Depth: how many other groups this loop lies within.
  const holders = loops.map((_l, i) => {
    const groups = new Map<number, number[]>();
    for (const j of touching[i]) {
      const g = find(j);
      if (g === find(i)) continue;
      groups.set(g, [...(groups.get(g) ?? []), j]);
    }
    const out: number[] = [];
    for (const [g, members] of groups) {
      // All of the group's shapes near it, not just those it touches.
      const all = loops.flatMap((_k, k) => (find(k) === g && boxesMeet(boxes[i], boxes[k], eps) ? [k] : []));
      if (within(tally(i, all.length ? all : members))) out.push(g);
    }
    return out;
  });
  const depth = holders.map((h) => h.length);
  const regions: Region[] = [];
  loops.forEach((outer, i) => {
    if (depth[i] % 2 !== 0) return;
    // A hole belongs to every shape in the group it lies within that it touches.
    const holes = loops.filter((_l, j) => depth[j] === depth[i] + 1 && holders[j].includes(find(i)) && touching[j].includes(i));
    regions.push({ outer, holes });
  });
  return regions;
}

