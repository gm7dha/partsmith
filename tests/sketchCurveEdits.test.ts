import { describe, expect, it } from "vitest";

import { addCircle, addLine, applyRelation, deleteItems, dragPoint, pointPos, setDimensionValue, type Placed } from "../src/sketch/ops";
import { addConic, addEllipse, addSpline, offsetCurves, patternCurves, readPatternSettings, splitAt, trimAt } from "../src/sketch/tools";
import { conicAt } from "../src/sketch/spline";
import { curveParam, nearestParam, OFFSET_TOLERANCE, type CurveParam } from "../src/sketch/curves";
import { findRegions } from "../src/sketch/regions";
import { analyzeSketch, solveSketch } from "../src/sketch/solver";
import { emptySketch, type SketchCircle, type SketchCurve, type SketchData, type SketchEllipse, type SketchSpline } from "../src/sketch/types";
import { parseSketchData } from "../src/sketch/validate";

type P2 = [number, number];
const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const curve = <T extends SketchCurve>(s: SketchData, id: string) => s.curves.find((c) => c.id === id) as T;
const splines = (s: SketchData) => s.curves.filter((c): c is SketchSpline => c.type === "spline");
const ellipses = (s: SketchData) => s.curves.filter((c): c is SketchEllipse => c.type === "ellipse");

/** Points along a path, `n` per unit of its parameter span (at least 50). */
const samples = (p: CurveParam, n = 200): P2[] => Array.from({ length: n + 1 }, (_, i) => p.at(p.lo + ((p.hi - p.lo) * i) / n));
/** How far q is from the nearest of the paths. */
const gap = (paths: CurveParam[], q: P2) => Math.min(...paths.map((p) => Math.hypot(p.at(nearestParam(p, q))[0] - q[0], p.at(nearestParam(p, q))[1] - q[1])));
/** Largest distance from any sample of `from` to `to` (and the other way): 0 when they're the same curve. */
function mismatch(from: CurveParam[], to: CurveParam[]): number {
  let worst = 0;
  for (const p of from) for (const q of samples(p)) worst = Math.max(worst, gap(to, q));
  return worst;
}

const linear = (o: ReturnType<typeof readPatternSettings>) => (typeof o === "string" || o.kind !== "linear" ? null : o);
const wavySpline = () => addSpline(emptySketch(), [at(0, 0), at(10, 8), at(20, -4), at(30, 6), at(40, 0)], false);
/** A gentler wave (its tightest bend has a radius of about 4.7 mm), for offsets. */
const gentle = () => addSpline(emptySketch(), [at(0, 0), at(15, 6), at(30, -3), at(45, 5), at(60, 0)], false);

describe("Split splines, conics and ellipses", () => {
  it("splits a spline in two that follow it exactly", () => {
    const r = wavySpline();
    const before = curveParam(r.sketch, curve(r.sketch, r.splineId));
    const split = splitAt(r.sketch, r.splineId, { x: 15, y: 3 });
    expect(split.error).toBeUndefined();
    expect(split.lineIds).toHaveLength(2);
    const pieces = split.lineIds.map((id) => curveParam(split.sketch, curve(split.sketch, id)));
    expect(mismatch([before], pieces)).toBeLessThan(1e-6);
    expect(mismatch(pieces, [before])).toBeLessThan(1e-6);
    // The two meet at one shared point, and the first keeps the spline's own start.
    const [a, b] = split.lineIds.map((id) => curve<SketchSpline>(split.sketch, id));
    expect(a.points[a.points.length - 1]).toBe(b.points[0]);
    expect(a.points[0]).toBe(curve<SketchSpline>(r.sketch, r.splineId).points[0]);
    // Handles are pinned only near the cut: the far points still curve by themselves.
    expect(Object.keys({ ...a.tangents, ...b.tangents }).length).toBeLessThan(5);
    expect(solveSketch(split.sketch).ok).toBe(true);
  });

  it("splits at one of the spline's own points when clicked there", () => {
    const r = wavySpline();
    const sp = curve<SketchSpline>(r.sketch, r.splineId);
    const split = splitAt(r.sketch, r.splineId, { x: 20, y: -4 });
    expect(split.error).toBeUndefined();
    expect(curve<SketchSpline>(split.sketch, split.lineIds[1]).points[0]).toBe(sp.points[2]);
    expect(split.sketch.points).toHaveLength(r.sketch.points.length);
  });

  it("splits a conic into two conics on the same curve", () => {
    const r = addConic(emptySketch(), at(0, 0), at(20, 0), at(10, 15), 0.4);
    const c = curve<SketchSpline>(r.sketch, r.conicId);
    const [a, apex, b] = c.points.map((id) => pointPos(r.sketch, id));
    const split = splitAt(r.sketch, r.conicId, { x: 6, y: 5 });
    expect(split.error).toBeUndefined();
    const pieces = split.lineIds.map((id) => curve<SketchSpline>(split.sketch, id));
    expect(pieces.every((p) => p.conic !== undefined && p.points.length === 3)).toBe(true);
    // Every point on the exact pieces lies on the exact original conic.
    const original = curveParam(r.sketch, c);
    let worst = 0;
    for (const p of pieces) {
      const [pa, pc, pb] = p.points.map((id) => pointPos(split.sketch, id));
      for (let i = 0; i <= 50; i++) worst = Math.max(worst, gap([original], conicAt(pa, pc, pb, p.conic!, i / 50).p));
    }
    expect(worst).toBeLessThan(1e-9);
    expect(conicAt(a, apex, b, 0.4, 0).p).toEqual(a);
  });

  it("explains that a closed spline or whole ellipse needs Trim", () => {
    const e = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    expect(splitAt(e.sketch, e.ellipseId, { x: 0, y: 10 }).error).toMatch(/Trim/);
    const r = wavySpline();
    expect(splitAt(r.sketch, r.splineId, { x: 0.1, y: 0.1 }).error).toMatch(/further from/);
  });
});

/** An ellipse 40 × 20 round the origin with a level line through its middle. */
function ellipseAndLine() {
  const e = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
  const l = addLine(e.sketch, at(-30, 0), at(30, 0));
  return { sketch: l.sketch, ellipseId: e.ellipseId, lineId: l.lineId };
}
/** The ellipse's own equation at q: (along / rx)² + (across / ry)² − 1, zero on it. */
const onEllipse = (s: SketchData, e: SketchEllipse, q: P2) => {
  const [cx, cy] = pointPos(s, e.center);
  const [mx, my] = pointPos(s, e.major);
  const rx = Math.hypot(mx - cx, my - cy);
  const ry = Math.hypot(pointPos(s, e.minor)[0] - cx, pointPos(s, e.minor)[1] - cy);
  const [ux, uy] = [(mx - cx) / rx, (my - cy) / rx];
  const along = (q[0] - cx) * ux + (q[1] - cy) * uy;
  const across = -(q[0] - cx) * uy + (q[1] - cy) * ux;
  return (along / rx) ** 2 + (across / ry) ** 2 - 1;
};

describe("Trim splines and ellipses", () => {
  it("trims an ellipse to the part on the other side of a line, keeping it an ellipse", () => {
    const t = ellipseAndLine();
    const r = trimAt(t.sketch, t.ellipseId, { x: 0, y: -10 });
    expect(r.error).toBeUndefined();
    const e = curve<SketchEllipse>(r.sketch, t.ellipseId);
    expect(e.start && e.end).toBeTruthy();
    const path = curveParam(r.sketch, e);
    expect(Math.max(...samples(path).map((q) => Math.abs(onEllipse(r.sketch, e, q))))).toBeLessThan(1e-12);
    // It runs from (20, 0) over the top to (−20, 0).
    expect(pointPos(r.sketch, e.start!).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([20, 0]);
    expect(pointPos(r.sketch, e.end!).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([-20, 0]);
    expect(path.at((path.lo + path.hi) / 2)[1]).toBeCloseTo(10, 9);
    // Its ends are held on the line; two more freedoms than a whole ellipse (where along it each end is), less the two on the line.
    expect(r.sketch.constraints.filter((k) => k.type === "pointOnLine")).toHaveLength(2);
  });

  it("makes a half-ellipse shape with a trimmed line that extrudes as one area", () => {
    const t = ellipseAndLine();
    let s = trimAt(t.sketch, t.ellipseId, { x: 0, y: -10 }).sketch;
    s = trimAt(s, t.lineId, { x: -25, y: 0 }).sketch;
    s = trimAt(s, t.lineId, { x: 25, y: 0 }).sketch;
    const { regions, problems } = findRegions(s);
    expect(problems).toEqual([]);
    expect(regions).toHaveLength(1);
    expect(regions[0].outer.segments.map((g) => g.kind).sort()).toEqual(["ellipseArc", "line"]);
    expect(regions[0].outer.area).toBeCloseTo((Math.PI * 20 * 10) / 2, 0);
  });

  it("a part of an ellipse stays on it when the ellipse is resized", () => {
    const t = ellipseAndLine();
    const r = trimAt(t.sketch, t.ellipseId, { x: 0, y: -10 });
    const e = curve<SketchEllipse>(r.sketch, t.ellipseId);
    const moved = dragPoint(r.sketch, e.minor, 0, 14);
    expect(Math.abs(onEllipse(moved, e, pointPos(moved, e.start!)))).toBeLessThan(1e-7);
    expect(Math.abs(onEllipse(moved, e, pointPos(moved, e.end!)))).toBeLessThan(1e-7);
    // Freedom: a whole ellipse has 5; its part 2 more (where each end sits along it).
    const free = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    expect(analyzeSketch(free.sketch).freedom).toBe(5);
    const lone = { ...r.sketch, constraints: [], curves: [curve<SketchEllipse>(r.sketch, t.ellipseId)] };
    const used = new Set([e.center, e.major, e.minor, e.start!, e.end!]);
    expect(analyzeSketch({ ...lone, points: lone.points.filter((p) => used.has(p.id)) }).freedom).toBe(7);
  });

  it("trims where two ellipses cross, exactly on both", () => {
    const a = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    const b = addEllipse(a.sketch, at(15, 5), at(15, 25), [5, 5]);
    const r = trimAt(b.sketch, a.ellipseId, { x: 20, y: 0 });
    expect(r.error).toBeUndefined();
    const ea = curve<SketchEllipse>(r.sketch, a.ellipseId);
    const eb = curve<SketchEllipse>(r.sketch, b.ellipseId);
    for (const id of [ea.start!, ea.end!]) {
      expect(Math.abs(onEllipse(r.sketch, ea, pointPos(r.sketch, id)))).toBeLessThan(1e-9);
      expect(Math.abs(onEllipse(r.sketch, eb, pointPos(r.sketch, id)))).toBeLessThan(1e-9);
    }
    // The clicked stretch (round (20, 0)) is gone.
    expect(gap([curveParam(r.sketch, ea)], [20, 0])).toBeGreaterThan(1);
  });

  it("trims the middle out of a spline between two lines, leaving two exact pieces", () => {
    const r = wavySpline();
    const before = curveParam(r.sketch, curve(r.sketch, r.splineId));
    const l1 = addLine(r.sketch, at(12, -20), at(12, 20));
    const l2 = addLine(l1.sketch, at(28, -20), at(28, 20));
    const t = trimAt(l2.sketch, r.splineId, { x: 20, y: -4 });
    expect(t.error).toBeUndefined();
    const pieces = splines(t.sketch);
    expect(pieces).toHaveLength(2);
    const paths = pieces.map((p) => curveParam(t.sketch, p));
    expect(mismatch(paths, [before])).toBeLessThan(1e-6);
    // The ends at the cuts sit on the lines, exactly.
    const ends = pieces.map((p) => pointPos(t.sketch, p.points[p === pieces[0] ? p.points.length - 1 : 0]).map((v) => Math.round(v * 1e9) / 1e9)[0]).sort((x, y) => x - y);
    expect(ends).toEqual([12, 28]);
    expect(gap(paths, before.at(2))).toBeGreaterThan(1);
  });

  it("trims a closed spline crossed twice by a line into an open one", () => {
    const r = addSpline(emptySketch(), [at(0, 0), at(20, 0), at(20, 20), at(0, 20)], true);
    const before = curveParam(r.sketch, curve(r.sketch, r.splineId));
    const l = addLine(r.sketch, at(-10, 10), at(30, 10));
    const t = trimAt(l.sketch, r.splineId, { x: 10, y: -3 });
    expect(t.error).toBeUndefined();
    const sp = curve<SketchSpline>(t.sketch, r.splineId);
    expect(sp.closed).toBe(false);
    const path = curveParam(t.sketch, sp);
    expect(mismatch([path], [before])).toBeLessThan(1e-6);
    expect(Math.min(...samples(path).map((q) => q[1]))).toBeGreaterThan(10 - 1e-9);
  });

  it("trims where two splines cross, the cut on both", () => {
    const r = wavySpline();
    const b = addSpline(r.sketch, [at(5, -10), at(18, 3), at(25, 15)], false);
    const before = curveParam(b.sketch, curve(b.sketch, b.splineId));
    const other = curveParam(b.sketch, curve(b.sketch, r.splineId));
    const t = trimAt(b.sketch, b.splineId, { x: 24, y: 13 });
    expect(t.error).toBeUndefined();
    const sp = curve<SketchSpline>(t.sketch, b.splineId);
    const end = pointPos(t.sketch, sp.points[sp.points.length - 1]);
    expect(gap([other], end)).toBeLessThan(1e-9);
    expect(gap([before], end)).toBeLessThan(1e-9);
    expect(mismatch([curveParam(t.sketch, sp)], [before])).toBeLessThan(1e-6);
  });

  it("a line can be trimmed back to where a spline crosses it, exactly on the spline", () => {
    const r = wavySpline();
    const path = curveParam(r.sketch, curve(r.sketch, r.splineId));
    const l = addLine(r.sketch, at(13, -20), at(13, 20));
    const t = trimAt(l.sketch, l.lineId, { x: 13, y: 19 });
    expect(t.error).toBeUndefined();
    const line = curve<{ type: "line"; p1: string; p2: string } & SketchCurve>(t.sketch, l.lineId);
    const top = [pointPos(t.sketch, line.p1), pointPos(t.sketch, line.p2)].sort((p, q) => q[1] - p[1])[0];
    expect(gap([path], top)).toBeLessThan(1e-9);
  });
});

describe("Offset splines and ellipses", () => {
  /** Largest error of an offset copy's distance from its original, over many places along it. */
  const offsetError = (s: SketchData, copyId: string, origId: string, d: number) => {
    const copy = curveParam(s, curve(s, copyId));
    const orig = curveParam(s, curve(s, origId));
    return Math.max(...samples(copy, 400).map((q) => Math.abs(gap([orig], q) - d)));
  };

  it("offsets a spline within the tolerance, on the side clicked", () => {
    const r = gentle();
    const o = offsetCurves(r.sketch, r.splineId, { x: 15, y: 9 }, "2");
    expect(o.error).toBeUndefined();
    expect(o.curveIds).toHaveLength(1);
    expect(OFFSET_TOLERANCE).toBeLessThanOrEqual(0.01);
    expect(offsetError(o.sketch, o.curveIds[0], r.splineId, 2)).toBeLessThan(OFFSET_TOLERANCE);
    // Above the curve near (15, 6): the side that was clicked.
    const copy = curveParam(o.sketch, curve(o.sketch, o.curveIds[0]));
    expect(copy.at(nearestParam(copy, [15, 8]))[1]).toBeGreaterThan(7.5);
    // It adds nothing free: it's held to the original.
    expect(analyzeSketch(o.sketch).freedom).toBe(analyzeSketch(r.sketch).freedom);
    expect(o.sketch.constraints.find((k) => k.type === "offset")?.refs).toEqual([o.curveIds[0], r.splineId]);
  });

  it("follows when the spline is reshaped, and when the distance changes", () => {
    const r = gentle();
    const o = offsetCurves(r.sketch, r.splineId, { x: 15, y: 9 }, "2");
    const sp = curve<SketchSpline>(o.sketch, r.splineId);
    const moved = dragPoint(o.sketch, sp.points[2], 30, -5);
    expect(Math.hypot(pointPos(moved, sp.points[2])[0] - 30, pointPos(moved, sp.points[2])[1] + 5)).toBeLessThan(1e-5);
    expect(offsetError(moved, o.curveIds[0], r.splineId, 2)).toBeLessThan(OFFSET_TOLERANCE);
    const dim = moved.constraints.find((k) => k.type === "offset")!;
    const wider = setDimensionValue(moved, dim.id, "3.5");
    expect(wider.error).toBeUndefined();
    expect(offsetError(wider.sketch, o.curveIds[0], r.splineId, 3.5)).toBeLessThan(OFFSET_TOLERANCE);
  });

  it("offsets a whole ellipse into a closed spline that follows it", () => {
    const e = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    const o = offsetCurves(e.sketch, e.ellipseId, { x: 0, y: 13 }, "3");
    expect(o.error).toBeUndefined();
    const copy = curve<SketchSpline>(o.sketch, o.curveIds[0]);
    expect(copy.closed).toBe(true);
    expect(offsetError(o.sketch, copy.id, e.ellipseId, 3)).toBeLessThan(OFFSET_TOLERANCE);
    const el = curve<SketchEllipse>(o.sketch, e.ellipseId);
    const bigger = dragPoint(o.sketch, el.major, 26, 0);
    expect(offsetError(bigger, copy.id, e.ellipseId, 3)).toBeLessThan(OFFSET_TOLERANCE);
    expect(findRegions(bigger).regions.length).toBeGreaterThan(0);
  });

  it("won't offset inwards past the tightest bend", () => {
    // The ends of a 40 × 20 ellipse bend with radius 10² / 20 = 5.
    const e = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    expect(offsetCurves(e.sketch, e.ellipseId, { x: 0, y: 7 }, "6").error).toMatch(/tightest bend/);
    expect(offsetCurves(e.sketch, e.ellipseId, { x: 0, y: 7 }, "4").error).toBeUndefined();
  });

  it("gets more points when the original changes so much the copy would stray, keeping its ends", () => {
    const r = gentle();
    const o = offsetCurves(r.sketch, r.splineId, { x: 15, y: 9 }, "2");
    const sp = curve<SketchSpline>(o.sketch, r.splineId);
    const before = curve<SketchSpline>(o.sketch, o.curveIds[0]);
    const moved = dragPoint(o.sketch, sp.points[1], 15, 14);
    const after = curve<SketchSpline>(moved, o.curveIds[0]);
    expect(after.points.length).toBeGreaterThan(before.points.length);
    expect(after.points[0]).toBe(before.points[0]);
    expect(after.points[after.points.length - 1]).toBe(before.points[before.points.length - 1]);
    expect(offsetError(moved, o.curveIds[0], r.splineId, 2)).toBeLessThan(OFFSET_TOLERANCE);
    // Dragging stays quick: the copy's points are worked out after solving, not solved for.
    const t = performance.now();
    let k = moved;
    for (let i = 0; i < 10; i++) k = dragPoint(k, sp.points[1], 15, 14 - i * 0.2);
    expect(performance.now() - t).toBeLessThan(3000); // generous: CI machines are slow
  });

  it("an offset copy joined to a line keeps the line on its end", () => {
    const r = gentle();
    const o = offsetCurves(r.sketch, r.splineId, { x: 15, y: 9 }, "2");
    const copy = curve<SketchSpline>(o.sketch, o.curveIds[0]);
    const end = copy.points[copy.points.length - 1];
    const [ex, ey] = pointPos(o.sketch, end);
    const l = addLine(o.sketch, { x: ex, y: ey, snap: { kind: "point", id: end } }, at(ex + 10, ey + 10));
    const sp = curve<SketchSpline>(l.sketch, r.splineId);
    const moved = dragPoint(l.sketch, sp.points[4], 60, 4);
    expect(solveSketch(moved).ok).toBe(true);
    expect(offsetError(moved, o.curveIds[0], r.splineId, 2)).toBeLessThan(OFFSET_TOLERANCE);
    const line = curve<{ type: "line"; p1: string; p2: string } & SketchCurve>(moved, l.lineId);
    expect(line.p1).toBe(end);
  });

  it("offsets part of an ellipse", () => {
    const t = ellipseAndLine();
    const r = trimAt(t.sketch, t.ellipseId, { x: 0, y: -10 });
    const o = offsetCurves(r.sketch, t.ellipseId, { x: 0, y: 12 }, "1.5");
    expect(o.error).toBeUndefined();
    expect(curve<SketchSpline>(o.sketch, o.curveIds[0]).closed).toBe(false);
    expect(offsetError(o.sketch, o.curveIds[0], t.ellipseId, 1.5)).toBeLessThan(OFFSET_TOLERANCE);
  });

  it("saves and opens again", () => {
    const r = gentle();
    const o = offsetCurves(r.sketch, r.splineId, { x: 15, y: 9 }, "2");
    const back = parseSketchData(JSON.parse(JSON.stringify(o.sketch)))!;
    expect(back).toEqual(o.sketch);
  });
});

describe("Linked linear sketch pattern", () => {
  it("copies follow the original", () => {
    const c = addCircle(emptySketch(), at(0, 0), 2);
    const p = patternCurves(c.sketch, [c.circleId], { kind: "linear", count: 3, spacing: 10, angle: 0 });
    expect(p.error).toBeUndefined();
    // The copies add nothing free.
    expect(analyzeSketch(p.sketch).freedom).toBe(analyzeSketch(c.sketch).freedom);
    const centre = curve<SketchCircle>(p.sketch, c.circleId).center;
    const moved = dragPoint(p.sketch, centre, 5, 5);
    const copies = p.curveIds.map((id) => pointPos(moved, curve<SketchCircle>(moved, id).center).map((v) => Math.round(v * 1e9) / 1e9));
    expect(copies).toEqual([
      [15, 5],
      [25, 5],
    ]);
    const sized = applyRelation(moved, "fix", [centre]).sketch;
    expect(analyzeSketch(sized).definedPoints.has(curve<SketchCircle>(sized, p.curveIds[1]).center)).toBe(true);
  });

  it("copies follow the line the direction came from", () => {
    const l = addLine(emptySketch(), at(0, -5), at(10, -5), { construction: true });
    const c = addCircle(l.sketch, at(0, 0), 2);
    const opts = readPatternSettings(c.sketch, { patternKind: "linear", patternCount: 3, patternSpacing: "10", patternAngle: "0", patternCentre: "origin", patternLine: l.lineId });
    expect(linear(opts)?.lineId).toBe(l.lineId);
    if (typeof opts === "string") return;
    const p = patternCurves(c.sketch, [c.circleId], opts);
    const line = curve<{ type: "line"; p1: string; p2: string } & SketchCurve>(p.sketch, l.lineId);
    // Swing the line round to point straight up: the row turns with it.
    const turned = dragPoint(p.sketch, line.p2, 0, 5);
    expect(pointPos(turned, line.p2)).toEqual([0, 5]);
    const copies = p.curveIds.map((id) => pointPos(turned, curve<SketchCircle>(turned, id).center).map((v) => Math.round(v * 1e9) / 1e9));
    expect(copies).toEqual([
      [0, 10],
      [0, 20],
    ]);
    // Typing the way back along the line goes the other way along it; any other angle is just that angle.
    const back = readPatternSettings(c.sketch, { patternKind: "linear", patternCount: 3, patternSpacing: "10", patternAngle: "180", patternCentre: "origin", patternLine: l.lineId });
    expect(linear(back)?.reverse).toBe(true);
    const other = readPatternSettings(c.sketch, { patternKind: "linear", patternCount: 3, patternSpacing: "10", patternAngle: "45", patternCentre: "origin", patternLine: l.lineId });
    expect(linear(other)?.lineId).toBe(undefined);
    expect(linear(other)?.angle).toBe(45);
  });

  it("splines and ellipses can be patterned and stay linked", () => {
    const e = addEllipse(emptySketch(), at(0, 0), at(5, 0), [0, 2]);
    const p = patternCurves(e.sketch, [e.ellipseId], { kind: "linear", count: 4, spacing: 12, angle: 90 });
    expect(p.error).toBeUndefined();
    expect(ellipses(p.sketch)).toHaveLength(4);
    const el = curve<SketchEllipse>(p.sketch, e.ellipseId);
    const moved = dragPoint(p.sketch, el.major, 7, 0);
    const last = curve<SketchEllipse>(moved, p.curveIds[2]);
    expect(pointPos(moved, last.major).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([7, 36]);
  });
});

describe("tangent where a part of an ellipse ends", () => {
  it("stands a line square off the end of a half-ellipse", () => {
    const t = ellipseAndLine();
    const r = trimAt(t.sketch, t.ellipseId, { x: 0, y: -10 });
    const e = curve<SketchEllipse>(r.sketch, t.ellipseId);
    const s = applyRelation(r.sketch, "fix", [e.center, e.major, e.minor, e.start!]).sketch;
    const l = addLine(s, { x: 20, y: 0, snap: { kind: "point", id: e.start! } }, at(25, 12));
    const tg = applyRelation(l.sketch, "tangent", [l.lineId, e.id]);
    expect(tg.error).toBeUndefined();
    const line = curve<{ type: "line"; p1: string; p2: string } & SketchCurve>(tg.sketch, l.lineId);
    // An ellipse's side at the end of its long axis runs straight up.
    expect(Math.abs(pointPos(tg.sketch, line.p2)[0] - 20)).toBeLessThan(1e-6);
  });
});

describe("old sketches", () => {
  it("open unchanged: no new fields appear", () => {
    const r = wavySpline();
    const json = JSON.parse(JSON.stringify(r.sketch));
    expect(parseSketchData(json)).toEqual(r.sketch);
    expect("tangentsIn" in splines(r.sketch)[0]).toBe(false);
    const e = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    expect("start" in ellipses(e.sketch)[0]).toBe(false);
  });

  it("split splines and parts of ellipses save and open again", () => {
    const r = wavySpline();
    const split = splitAt(r.sketch, r.splineId, { x: 15, y: 3 });
    expect(splines(split.sketch).some((c) => c.tangentsIn)).toBe(true);
    expect(parseSketchData(JSON.parse(JSON.stringify(split.sketch)))).toEqual(split.sketch);
    const t = ellipseAndLine();
    const trimmed = trimAt(t.sketch, t.ellipseId, { x: 0, y: -10 }).sketch;
    expect(parseSketchData(JSON.parse(JSON.stringify(trimmed)))).toEqual(trimmed);
  });
});

describe("relations on a cut spline", () => {
  it("a smooth join at a spline's far end stays with the piece that keeps that end", () => {
    const l = addLine(emptySketch(), at(40, 0), at(50, 0));
    const line = curve<{ type: "line"; p1: string; p2: string } & SketchCurve>(l.sketch, l.lineId);
    const sp = addSpline(l.sketch, [at(0, 0), at(10, 8), at(20, -4), at(30, 6), { x: 40, y: 0, snap: { kind: "point", id: line.p1 } }], false);
    const s = applyRelation(sp.sketch, "tangent", [l.lineId, sp.splineId]).sketch;
    const split = splitAt(s, sp.splineId, { x: 15, y: 3 });
    expect(split.error).toBeUndefined();
    const tg = split.sketch.constraints.find((k) => k.type === "tangent")!;
    expect(tg.refs).toContain(split.lineIds[1]);
  });
});

describe("offset copies refitted after big changes", () => {
  const setup = () => {
    const r = addSpline(emptySketch(), [at(0, 0), at(20, 6), at(40, 0)], false);
    const o = offsetCurves(r.sketch, r.splineId, { x: 20, y: 10 }, "2");
    const copy = curve<SketchSpline>(o.sketch, o.curveIds[0]);
    const midIndex = (copy.points.length - 1) / 2;
    return { r, o, copy, mid: copy.points[midIndex] };
  };
  const reshape = (s: SketchData, splineId: string) => {
    const sp = curve<SketchSpline>(s, splineId);
    for (const y of [10, 14, 18, 22]) s = dragPoint(s, sp.points[1], 20, y);
    return s;
  };

  it("keeps a point a line was drawn from", () => {
    const { r, o, copy, mid } = setup();
    expect(Number.isInteger((copy.points.length - 1) / 2)).toBe(true);
    const [mx, my] = pointPos(o.sketch, mid);
    const l = addLine(o.sketch, { x: mx, y: my, snap: { kind: "point", id: mid } }, at(mx, my + 15));
    const s = reshape(l.sketch, r.splineId);
    const after = curve<SketchSpline>(s, o.curveIds[0]);
    expect(after.points.length).toBeGreaterThan(copy.points.length);
    expect(after.points).toContain(mid);
    const line = curve<{ type: "line"; p1: string; p2: string } & SketchCurve>(s, l.lineId);
    expect(line.p1).toBe(mid);
    expect(s.points.some((p) => p.id === line.p1)).toBe(true);
    expect(findRegions(s).problems).toBeDefined();
    expect(solveSketch(s).ok).toBe(true);
    // The kept point is still on the offset, and the copy is still within the tolerance.
    const orig = curveParam(s, curve(s, r.splineId));
    expect(Math.abs(gap([orig], pointPos(s, mid)) - 2)).toBeLessThan(1e-6);
    const cp = curveParam(s, after);
    expect(Math.max(...samples(cp, 400).map((q) => Math.abs(gap([orig], q) - 2)))).toBeLessThan(OFFSET_TOLERANCE);
  });

  it("keeps a point joined by Coincident, and the join", () => {
    const { r, o, mid } = setup();
    const [mx, my] = pointPos(o.sketch, mid);
    const l = addLine(o.sketch, at(mx + 0.5, my + 0.5), at(mx, my + 15));
    const line = curve<{ type: "line"; p1: string; p2: string } & SketchCurve>(l.sketch, l.lineId);
    const joined = applyRelation(l.sketch, "coincident", [line.p1, mid]);
    expect(joined.error).toBeUndefined();
    const s = reshape(joined.sketch, r.splineId);
    expect(s.constraints.some((k) => k.type === "coincident" && k.refs.includes(mid))).toBe(true);
    expect(curve<SketchSpline>(s, o.curveIds[0]).points).toContain(mid);
    const [a, b] = [pointPos(s, line.p1), pointPos(s, mid)];
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-6);
  });
});

describe("trimming at a T", () => {
  it("cuts a line at the end of a line that stops on it, reusing that point", () => {
    const base = addLine(emptySketch(), at(0, 0), at(40, 0));
    const stem = addLine(base.sketch, at(20, 15), { x: 20, y: 0, snap: { kind: "curve", id: base.lineId } });
    const before = stem.sketch.points.length;
    const t = trimAt(stem.sketch, base.lineId, { x: 30, y: 0 });
    expect(t.error).toBeUndefined();
    // The far end goes with the piece cut away; no new point is added.
    expect(t.sketch.points).toHaveLength(before - 1);
    const line = curve<{ type: "line"; p1: string; p2: string } & SketchCurve>(t.sketch, base.lineId);
    expect([line.p1, line.p2]).toContain(stem.endId);
    expect(t.sketch.constraints.some((k) => k.type === "pointOnLine" && k.refs[0] === stem.endId && k.refs[1] === base.lineId)).toBe(false);
  });

  it("cuts a spline at the end of a line that stops on it", () => {
    const r = wavySpline();
    const path = curveParam(r.sketch, curve(r.sketch, r.splineId));
    const q = path.at(1.5);
    const stem = addLine(r.sketch, at(q[0], q[1] + 20), { x: q[0], y: q[1], snap: { kind: "curve", id: r.splineId } });
    const before = stem.sketch.points.length;
    const t = trimAt(stem.sketch, r.splineId, { x: 35, y: 4 });
    expect(t.error).toBeUndefined();
    const sp = curve<SketchSpline>(t.sketch, r.splineId);
    expect(sp.points[sp.points.length - 1]).toBe(stem.endId);
    expect(t.sketch.points.length).toBeLessThan(before);
    expect(t.sketch.constraints.some((k) => k.type === "pointOnCurve" && k.refs[0] === stem.endId)).toBe(false);
    expect(mismatch([curveParam(t.sketch, sp)], [path])).toBeLessThan(1e-6);
  });
});

describe("linear pattern along a line, more", () => {
  const rowAlong = () => {
    const l = addLine(emptySketch(), at(0, -5), at(10, -5), { construction: true, orientation: "horizontal" });
    const c = addCircle(l.sketch, at(0, 0), 2);
    const p = patternCurves(c.sketch, [c.circleId], { kind: "linear", count: 3, spacing: 10, angle: 0, lineId: l.lineId });
    return { l, c, p };
  };

  it("deleting the direction line keeps the copies following, the way it pointed", () => {
    const { l, c, p } = rowAlong();
    const gone = deleteItems(p.sketch, [l.lineId]);
    expect(gone.constraints.filter((k) => k.type === "patternMove")).toHaveLength(2);
    const centre = curve<SketchCircle>(gone, c.circleId).center;
    const moved = dragPoint(gone, centre, 3, 4);
    expect(pointPos(moved, curve<SketchCircle>(moved, p.curveIds[1]).center).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([23, 4]);
  });

  it("copies count as pinned down when the line's direction is (a level line), not only both its ends", () => {
    const { c, p } = rowAlong();
    const s = applyRelation(p.sketch, "fix", [curve<SketchCircle>(p.sketch, c.circleId).center]).sketch;
    expect(analyzeSketch(s).definedPoints.has(curve<SketchCircle>(s, p.curveIds[1]).center)).toBe(true);
  });
});
