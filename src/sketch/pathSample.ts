/**
 * A sketch's lines and curves, joined end to end, as a path in 3D you can walk
 * along by distance — for Curve pattern (copies spaced evenly along a path).
 */
import { planeFrame, toWorld, type SketchPlane, type Vec3 } from "./planes";
import { findChains, type Segment } from "./regions";
import { bezierAt } from "./spline";
import type { SketchData } from "./types";

export interface PathWalk {
  length: number;
  closed: boolean;
  /** The point and direction (unit) `d` mm along the path. */
  at: (d: number) => { point: Vec3; tangent: Vec3 };
}

/** A run of curve pieces as closely spaced points, in order. */
export function sampleSegments(segments: Segment[]): [number, number][] {
  const pts: [number, number][] = [];
  const push = (p: [number, number]) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-12) pts.push(p);
  };
  for (const sg of segments) {
    if (sg.kind === "line") {
      push(sg.from);
      push(sg.to);
    } else if (sg.kind === "bezier") {
      push(sg.from);
      for (let i = 1; i <= 32; i++) push(bezierAt([sg.from, sg.c1, sg.c2, sg.to], i / 32));
    } else if (sg.kind === "arc") {
      // The circle through its three points, walked from the start through the middle to the end.
      const [ax, ay] = sg.from;
      const [bx, by] = sg.mid;
      const [cx, cy] = sg.to;
      const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
      if (Math.abs(d) < 1e-12) {
        push(sg.from);
        push(sg.to);
        continue;
      }
      const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
      const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
      const r = Math.hypot(ax - ux, ay - uy);
      const a0 = Math.atan2(ay - uy, ax - ux);
      const turn = (from: number, to: number) => {
        let t = to - from;
        while (t <= 0) t += 2 * Math.PI;
        return t;
      };
      // Anticlockwise if the middle comes before the end going anticlockwise; otherwise clockwise.
      const ccw = turn(a0, Math.atan2(by - uy, bx - ux)) < turn(a0, Math.atan2(cy - uy, cx - ux));
      const sweep = ccw ? turn(a0, Math.atan2(cy - uy, cx - ux)) : -turn(Math.atan2(cy - uy, cx - ux), a0);
      const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 90)));
      push(sg.from);
      for (let i = 1; i <= n; i++) push([ux + r * Math.cos(a0 + (sweep * i) / n), uy + r * Math.sin(a0 + (sweep * i) / n)]);
    } else if (sg.kind === "circle") {
      for (let i = 0; i <= 180; i++) push([sg.center[0] + sg.radius * Math.cos((i * Math.PI) / 90), sg.center[1] + sg.radius * Math.sin((i * Math.PI) / 90)]);
    } else {
      const c = Math.cos(sg.angle);
      const sn = Math.sin(sg.angle);
      const at = (t: number): [number, number] => {
        const x = sg.rx * Math.cos(t);
        const y = sg.ry * Math.sin(t);
        return [sg.center[0] + x * c - y * sn, sg.center[1] + x * sn + y * c];
      };
      if (sg.kind === "ellipseArc") {
        // Part of an ellipse, from its `from` end to its `to` end (whichever way round that is).
        const p0 = at(sg.t0);
        const forward = Math.hypot(p0[0] - sg.from[0], p0[1] - sg.from[1]) <= Math.hypot(p0[0] - sg.to[0], p0[1] - sg.to[1]);
        const n = Math.max(8, Math.ceil((sg.t1 - sg.t0) / (Math.PI / 90)));
        for (let i = 0; i <= n; i++) push(at(forward ? sg.t0 + ((sg.t1 - sg.t0) * i) / n : sg.t1 - ((sg.t1 - sg.t0) * i) / n));
      } else for (let i = 0; i <= 180; i++) push(at((i * Math.PI) / 90));
    }
  }
  return pts;
}

/** The path, or a plain-English reason it can't be used. */
export function walkPath(plane: SketchPlane, data: SketchData, near?: Vec3): PathWalk | string {
  const { chains, problems } = findChains(data);
  if (chains.length === 0) return problems.length ? `The path must be one connected run of curves, with no branches. ${problems.join(" ")}` : "The path sketch has no lines or curves.";
  if (chains.length > 1 || problems.length) return "The path must be one connected run of lines and curves, with no branches or separate pieces.";
  const closed = chains[0].closed;
  const frame = planeFrame(plane);
  const pts = sampleSegments(chains[0].segments);
  let world = pts.map(([x, y]) => toWorld(frame, x, y));
  // An open path starts from the end nearest `near` (the thing being repeated), if given.
  if (near && !closed && world.length > 1) {
    const dist = (p: Vec3) => Math.hypot(p[0] - near[0], p[1] - near[1], p[2] - near[2]);
    if (dist(world[world.length - 1]) < dist(world[0]) - 1e-9) world = [...world].reverse();
  }
  const cum = [0];
  for (let i = 1; i < world.length; i++) cum.push(cum[i - 1] + Math.hypot(...(world[i].map((v, k) => v - world[i - 1][k]) as Vec3)));
  const length = cum[cum.length - 1];
  if (!(length > 1e-9)) return "The path has no length.";
  const at = (d: number) => {
    const t = Math.max(0, Math.min(length, d));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < t) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const f = (t - cum[i - 1]) / seg;
    const p0 = world[i - 1];
    const p1 = world[i];
    const dir = p1.map((v, k) => v - p0[k]) as Vec3;
    const l = Math.hypot(...dir) || 1;
    return { point: p0.map((v, k) => v + dir[k] * f) as Vec3, tangent: dir.map((v) => v / l) as Vec3 };
  };
  return { length, closed, at };
}

/** Where copies go: `count` evenly spaced points from the start (to the end, or once round a closed path). */
export function pathStations(walk: PathWalk, count: number): number[] {
  const n = Math.max(2, Math.round(count));
  const step = walk.closed ? walk.length / n : walk.length / (n - 1);
  return Array.from({ length: n }, (_, i) => i * step);
}
