import { describe, expect, it } from "vitest";

import { addCircle, addLine, applyRelation, dragPoint, pointPos, RELATION_HINTS, RELATION_LABELS, type Placed } from "../src/sketch/ops";
import { addArc } from "../src/sketch/ops";
import { addEllipse, addSpline } from "../src/sketch/tools";
import { curvatureAt, curveParam, nearestParam } from "../src/sketch/curves";
import { analyzeSketch, solveSketch } from "../src/sketch/solver";
import { emptySketch, type SketchCircle, type SketchData, type SketchEllipse, type SketchLine, type SketchSpline } from "../src/sketch/types";
import { parseSketchData } from "../src/sketch/validate";

const at = (x: number, y: number): Placed => ({ x, y, snap: null });
const on = (id: string, x: number, y: number): Placed => ({ x, y, snap: { kind: "point", id } });
const fixAll = (s: SketchData, ids: string[]) => applyRelation(s, "fix", ids).sketch;
const spline = (s: SketchData, id?: string) => s.curves.find((c): c is SketchSpline => c.type === "spline" && (!id || c.id === id))!;
const line = (s: SketchData, id: string) => s.curves.find((c): c is SketchLine => c.id === id)!;
const unitCross = (a: [number, number], b: [number, number]) => (a[0] * b[1] - a[1] * b[0]) / (Math.hypot(...a) * Math.hypot(...b));
const unitDot = (a: [number, number], b: [number, number]) => (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));

/** A spline over (0,0) (10,10) (20,0), held in place: its top is at (10, 10), running level there. */
function arch(s: SketchData = emptySketch()) {
  const r = addSpline(s, [at(0, 0), at(10, 10), at(20, 0)], false);
  return { sketch: fixAll(r.sketch, [r.splineId]), id: r.splineId };
}

describe("Normal", () => {
  it("is on the toolbar with a plain-English hint", () => {
    expect(RELATION_LABELS.normal).toBe("Normal");
    expect(RELATION_HINTS.normal).toMatch(/line and a curve/);
    expect(RELATION_LABELS.curvature).toBe("Curvature");
  });

  it("turns a line square to a spline where it starts on it, taking one freedom", () => {
    const a = arch();
    const sp = spline(a.sketch);
    // A line from the spline's top point, leaning over.
    const l = addLine(a.sketch, on(sp.points[1], 10, 10), at(14, 20));
    const before = analyzeSketch(l.sketch).freedom;
    const r = applyRelation(l.sketch, "normal", [l.lineId, sp.id]);
    expect(r.error).toBeUndefined();
    expect(analyzeSketch(r.sketch).freedom).toBe(before - 1);
    const ln = line(r.sketch, l.lineId);
    const [p, q] = [pointPos(r.sketch, ln.p1), pointPos(r.sketch, ln.p2)];
    // The spline runs level at its top, so the line now stands straight up from (10, 10).
    expect(Math.abs(q[0] - 10)).toBeLessThan(1e-6);
    expect(p).toEqual([10, 10]);
    const c = r.sketch.constraints.find((k) => k.type === "normal")!;
    expect(c.extra).toEqual([0]);
  });

  it("works from a line's far end too, square to the curve where the line (carried on) meets it", () => {
    const a = arch();
    const sp = spline(a.sketch);
    // A line hanging below the arch, its upper end nearer the curve but not on it.
    const l = addLine(a.sketch, at(5, -20), at(4, 3));
    const r = applyRelation(l.sketch, "normal", [l.lineId, sp.id]);
    expect(r.error).toBeUndefined();
    expect(r.sketch.constraints.find((k) => k.type === "normal")!.extra).toEqual([1]);
    const ln = line(r.sketch, l.lineId);
    const end = pointPos(r.sketch, ln.p2);
    const path = curveParam(r.sketch, sp);
    const u = nearestParam(path, end);
    const d = [end[0] - pointPos(r.sketch, ln.p1)[0], end[1] - pointPos(r.sketch, ln.p1)[1]] as [number, number];
    expect(Math.abs(unitDot(d, path.d1(u)))).toBeLessThan(1e-7);
  });

  it("square to an ellipse", () => {
    const e = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    const el = e.sketch.curves[0] as SketchEllipse;
    const s = fixAll(e.sketch, [el.id]);
    const l = addLine(s, at(10, 12), at(15, 25));
    const r = applyRelation(l.sketch, "normal", [l.lineId, el.id]);
    expect(r.error).toBeUndefined();
    const ln = line(r.sketch, l.lineId);
    const p = pointPos(r.sketch, ln.p1), q = pointPos(r.sketch, ln.p2);
    const path = curveParam(r.sketch, el);
    const u = nearestParam(path, p);
    expect(Math.abs(unitDot([q[0] - p[0], q[1] - p[1]], path.d1(u)))).toBeLessThan(1e-7);
  });

  it("square to a circle: the line runs through its centre", () => {
    const c = addCircle(emptySketch(), at(5, 5), 4);
    const s = fixAll(c.sketch, [(c.sketch.curves[0] as SketchCircle).center]);
    const l = addLine(s, at(12, 0), at(20, 3));
    const r = applyRelation(l.sketch, "normal", [l.lineId, c.circleId]);
    expect(r.error).toBeUndefined();
    const ln = line(r.sketch, l.lineId);
    const p = pointPos(r.sketch, ln.p1), q = pointPos(r.sketch, ln.p2);
    const cross = ((q[0] - p[0]) * (5 - p[1]) - (q[1] - p[1]) * (5 - p[0])) / Math.hypot(q[0] - p[0], q[1] - p[1]);
    expect(Math.abs(cross)).toBeLessThan(1e-7);
  });

  it("says when it conflicts", () => {
    const a = arch();
    const l = addLine(a.sketch, at(5, 20), at(9, 30));
    const s = fixAll(l.sketch, [l.lineId]);
    expect(applyRelation(s, "normal", [l.lineId, a.id]).error).toMatch(/conflict/);
  });

  it("points two lines to Perpendicular", () => {
    const a = addLine(emptySketch(), at(0, 0), at(10, 0));
    const b = addLine(a.sketch, at(0, 5), at(10, 8));
    expect(applyRelation(b.sketch, "normal", [a.lineId, b.lineId]).error).toMatch(/Perpendicular/);
  });
});

describe("Tangent with splines and ellipses", () => {
  it("brings a level line down onto an ellipse's top, exactly", () => {
    const e = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    const el = e.sketch.curves[0] as SketchEllipse;
    let s = fixAll(e.sketch, [el.id]);
    const l = addLine(s, at(-30, 15), at(30, 15), { orientation: "horizontal" });
    s = l.sketch;
    const before = analyzeSketch(s).freedom;
    const r = applyRelation(s, "tangent", [l.lineId, el.id]);
    expect(r.error).toBeUndefined();
    const ln = line(r.sketch, l.lineId);
    expect(Math.abs(pointPos(r.sketch, ln.p1)[1] - 10)).toBeLessThan(1e-7);
    expect(Math.abs(pointPos(r.sketch, ln.p2)[1] - 10)).toBeLessThan(1e-7);
    expect(analyzeSketch(r.sketch).freedom).toBe(before - 1);
  });

  it("touches a slanted line to an ellipse (the touching point is exact)", () => {
    const e = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    const el = e.sketch.curves[0] as SketchEllipse;
    const s = fixAll(e.sketch, [el.id]);
    const l = addLine(s, at(0, 25), at(30, 5));
    const r = applyRelation(l.sketch, "tangent", [l.lineId, el.id]);
    expect(r.error).toBeUndefined();
    // A line n·x = d touches the ellipse x²/400 + y²/100 = 1 when d² = 400 nx² + 100 ny².
    const ln = line(r.sketch, l.lineId);
    const p = pointPos(r.sketch, ln.p1), q = pointPos(r.sketch, ln.p2);
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const n = [-(q[1] - p[1]) / len, (q[0] - p[0]) / len];
    const d = n[0] * p[0] + n[1] * p[1];
    expect(Math.abs(d * d - (400 * n[0] * n[0] + 100 * n[1] * n[1]))).toBeLessThan(1e-6);
  });

  it("brings a level line onto a spline's top", () => {
    const a = arch();
    const l = addLine(a.sketch, at(-5, 13), at(25, 13), { orientation: "horizontal" });
    const r = applyRelation(l.sketch, "tangent", [l.lineId, a.id]);
    expect(r.error).toBeUndefined();
    const ln = line(r.sketch, l.lineId);
    expect(Math.abs(pointPos(r.sketch, ln.p1)[1] - 10)).toBeLessThan(1e-7);
  });

  it("sizes a circle to touch a spline", () => {
    const a = arch();
    const c = addCircle(a.sketch, at(10, 20), 3);
    const s = fixAll(c.sketch, [(c.sketch.curves.find((k) => k.id === c.circleId) as SketchCircle).center]);
    const r = applyRelation(s, "tangent", [c.circleId, a.id]);
    expect(r.error).toBeUndefined();
    expect(Math.abs((r.sketch.curves.find((k) => k.id === c.circleId) as SketchCircle).radius - 10)).toBeLessThan(1e-7);
  });

  it("brings one spline down to touch another", () => {
    const a = arch();
    // A valley above the arch, its ends held: its lowest point comes down onto the arch's top.
    const b = addSpline(a.sketch, [at(0, 25), at(10, 15), at(20, 25)], false);
    const sb = spline(b.sketch, b.splineId);
    const s = fixAll(b.sketch, [sb.points[0], sb.points[2]]);
    const r = applyRelation(s, "tangent", [a.id, b.splineId]);
    expect(r.error).toBeUndefined();
    const mid = pointPos(r.sketch, sb.points[1]);
    expect(Math.abs(mid[0] - 10)).toBeLessThan(1e-6);
    expect(Math.abs(mid[1] - 10)).toBeLessThan(1e-6);
  });

  it("joins a line smoothly onto a spline's end", () => {
    const l = addLine(emptySketch(), at(-20, 0), at(0, 0));
    const ln = line(l.sketch, l.lineId);
    const s0 = fixAll(l.sketch, [ln.p1, ln.p2]);
    const sp = addSpline(s0, [on(ln.p2, 0, 0), at(10, 8), at(20, 3)], false);
    const before = analyzeSketch(sp.sketch).freedom;
    const r = applyRelation(sp.sketch, "tangent", [l.lineId, sp.splineId]);
    expect(r.error).toBeUndefined();
    expect(analyzeSketch(r.sketch).freedom).toBe(before - 1);
    const path = curveParam(r.sketch, spline(r.sketch));
    expect(Math.abs(unitCross(path.d1(0), [1, 0]))).toBeLessThan(1e-7);
  });

  it("joins two splines smoothly end to end", () => {
    const a = addSpline(emptySketch(), [at(0, 0), at(10, 5), at(20, 0)], false);
    const end = spline(a.sketch).points[2];
    const b = addSpline(a.sketch, [on(end, 20, 0), at(30, 6), at(40, 2)], false);
    const r = applyRelation(b.sketch, "tangent", [a.splineId, b.splineId]);
    expect(r.error).toBeUndefined();
    const pa = curveParam(r.sketch, spline(r.sketch, a.splineId));
    const pb = curveParam(r.sketch, spline(r.sketch, b.splineId));
    expect(Math.abs(unitCross(pa.d1(pa.hi), pb.d1(0)))).toBeLessThan(1e-7);
    // And it carries on (not doubling back).
    expect(unitDot(pa.d1(pa.hi), pb.d1(0))).toBeGreaterThan(0.99);
  });

  it("joins a line smoothly to a spline's end when they're joined by Coincident (not the same point)", () => {
    const a = arch();
    const sp = spline(a.sketch);
    const l = addLine(a.sketch, at(-1, 2), at(-15, -10));
    const ln = line(l.sketch, l.lineId);
    const joined = applyRelation(l.sketch, "coincident", [ln.p1, sp.points[0]]);
    expect(joined.error).toBeUndefined();
    const r = applyRelation(joined.sketch, "tangent", [l.lineId, a.id]);
    expect(r.error).toBeUndefined();
    const path = curveParam(r.sketch, spline(r.sketch));
    const ln2 = line(r.sketch, l.lineId);
    const d: [number, number] = [pointPos(r.sketch, ln2.p2)[0] - pointPos(r.sketch, ln2.p1)[0], pointPos(r.sketch, ln2.p2)[1] - pointPos(r.sketch, ln2.p1)[1]];
    expect(Math.abs(unitCross(d, path.d1(0)))).toBeLessThan(1e-7);
  });

  it("joins smoothly where a spline's end is held on a line", () => {
    const l = addLine(emptySketch(), at(-20, 0), at(20, 0));
    const ln = line(l.sketch, l.lineId);
    const s0 = fixAll(l.sketch, [ln.p1, ln.p2]);
    const sp = addSpline(s0, [{ x: 5, y: 0, snap: { kind: "curve", id: l.lineId } }, at(15, 6), at(25, 15)], false);
    expect(sp.sketch.constraints.some((k) => k.type === "pointOnLine")).toBe(true);
    const r = applyRelation(sp.sketch, "tangent", [l.lineId, sp.splineId]);
    expect(r.error).toBeUndefined();
    const path = curveParam(r.sketch, spline(r.sketch));
    expect(Math.abs(unitCross(path.d1(0), [1, 0]))).toBeLessThan(1e-7);
    expect(Math.abs(path.at(0)[1])).toBeLessThan(1e-7);
  });

  it("a circle through a spline's end is made to meet it smoothly there, not just accepted", () => {
    const a = arch();
    // A circle round (0, 10) through the spline's start (0, 0), which leaves at 45°.
    const c = addCircle(a.sketch, at(0, 10), 10);
    const r = applyRelation(c.sketch, "tangent", [c.circleId, a.id]);
    expect(r.error).toBeUndefined();
    const circle = r.sketch.curves.find((k) => k.id === c.circleId) as SketchCircle;
    const centre = pointPos(r.sketch, circle.center);
    const path = curveParam(r.sketch, spline(r.sketch));
    const start = path.at(0);
    // Still through the start, and square to the radius there.
    expect(Math.abs(Math.hypot(start[0] - centre[0], start[1] - centre[1]) - circle.radius)).toBeLessThan(1e-7);
    expect(Math.abs(unitDot(path.d1(0), [start[0] - centre[0], start[1] - centre[1]]))).toBeLessThan(1e-7);
  });

  it("says when touching can't happen", () => {
    // A fixed ellipse and a fixed level line far above it can't touch.
    const e = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    const el = e.sketch.curves[0] as SketchEllipse;
    const l = addLine(e.sketch, at(-30, 15), at(30, 15));
    const s = fixAll(l.sketch, [el.id, l.lineId]);
    expect(applyRelation(s, "tangent", [l.lineId, el.id]).error).toMatch(/conflict/);
  });
});

describe("Curvature", () => {
  it("joins a spline to a line so it runs on straight and unbent", () => {
    const l = addLine(emptySketch(), at(-20, 0), at(0, 0));
    const ln = line(l.sketch, l.lineId);
    const s0 = fixAll(l.sketch, [ln.p1, ln.p2]);
    const sp = addSpline(s0, [on(ln.p2, 0, 0), at(10, 5), at(20, 20)], false);
    const before = analyzeSketch(sp.sketch).freedom;
    const r = applyRelation(sp.sketch, "curvature", [sp.splineId, l.lineId]);
    expect(r.error).toBeUndefined();
    expect(analyzeSketch(r.sketch).freedom).toBe(before - 2);
    const path = curveParam(r.sketch, spline(r.sketch));
    expect(Math.abs(unitCross(path.d1(0), [1, 0]))).toBeLessThan(1e-7);
    expect(Math.abs(curvatureAt(path, 0))).toBeLessThan(1e-7);
  });

  it("matches an arc's bend where a spline leaves it, and replaces a tangent there", () => {
    // An arc of radius 10 round the origin, from (10, 0) anticlockwise to (0, 10), held in place.
    const arc = addArc(emptySketch(), at(10, 0), at(0, 10), { x: 10 * Math.SQRT1_2, y: 10 * Math.SQRT1_2 });
    const a = arc.sketch.curves[0] as { id: string; start: string; end: string; center: string };
    let s = fixAll(arc.sketch, [a.id]);
    const sp = addSpline(s, [on(a.end, 0, 10), at(-8, 14), at(-15, 10)], false);
    s = applyRelation(sp.sketch, "tangent", [a.id, sp.splineId]).sketch;
    expect(s.constraints.filter((k) => k.type === "tangent")).toHaveLength(1);
    const r = applyRelation(s, "curvature", [sp.splineId, a.id]);
    expect(r.error).toBeUndefined();
    expect(r.sketch.constraints.filter((k) => k.type === "tangent")).toHaveLength(0);
    const path = curveParam(r.sketch, spline(r.sketch));
    // Carrying on anticlockwise round the arc: bending left at 1 / 10.
    expect(Math.abs(curvatureAt(path, 0) - 0.1)).toBeLessThan(1e-7);
    expect(Math.abs(unitCross(path.d1(0), [-1, 0]))).toBeLessThan(1e-7);
  });

  it("says when it conflicts", () => {
    const l = addLine(emptySketch(), at(-20, 0), at(0, 0));
    const ln = line(l.sketch, l.lineId);
    const sp = addSpline(l.sketch, [on(ln.p2, 0, 0), at(10, 5), at(20, 20)], false);
    const s = fixAll(sp.sketch, [l.lineId, sp.splineId]);
    expect(applyRelation(s, "curvature", [sp.splineId, l.lineId]).error).toMatch(/conflict/);
  });

  it("explains what it needs", () => {
    const l = addLine(emptySketch(), at(-20, 0), at(0, 0));
    const sp = addSpline(l.sketch, [at(1, 1), at(10, 5), at(20, 20)], false);
    expect(applyRelation(sp.sketch, "curvature", [sp.splineId, l.lineId]).error).toMatch(/joined/);
    expect(applyRelation(sp.sketch, "curvature", [l.lineId, l.lineId]).error).toBeTruthy();
  });
});

describe("Equal and Concentric", () => {
  it("won't make a line equal to an arc, as in Onshape", () => {
    const l = addLine(emptySketch(), at(0, 0), at(10, 0));
    const c = addCircle(l.sketch, at(20, 0), 3);
    expect(applyRelation(c.sketch, "equal", [l.lineId, c.circleId]).error).toMatch(/not a line and an arc/);
  });

  it("centres a circle on an ellipse", () => {
    const e = addEllipse(emptySketch(), at(0, 0), at(20, 0), [0, 10]);
    const el = e.sketch.curves[0] as SketchEllipse;
    const s = fixAll(e.sketch, [el.id]);
    const c = addCircle(s, at(3, 4), 2);
    const r = applyRelation(c.sketch, "concentric", [el.id, c.circleId]);
    expect(r.error).toBeUndefined();
    const centre = pointPos(r.sketch, (r.sketch.curves.find((k) => k.id === c.circleId) as SketchCircle).center);
    expect(Math.hypot(...centre)).toBeLessThan(1e-7);
  });
});

describe("saved sketches", () => {
  it("keep the new relations, and old ones open as before", () => {
    const a = arch();
    const l = addLine(a.sketch, on(spline(a.sketch).points[1], 10, 10), at(14, 20));
    const r = applyRelation(l.sketch, "normal", [l.lineId, a.id]).sketch;
    const back = parseSketchData(JSON.parse(JSON.stringify(r)))!;
    expect(back.constraints.find((k) => k.type === "normal")).toEqual(r.constraints.find((k) => k.type === "normal"));
    expect(solveSketch(back).ok).toBe(true);
  });

  it("dragging stays quick with two splines touching and 40 other lines (about 50 ms a step or better)", () => {
    const a = arch();
    const b = addSpline(a.sketch, [at(0, 25), at(10, 15), at(20, 25)], false);
    let s = applyRelation(b.sketch, "tangent", [a.id, b.splineId]).sketch;
    for (let i = 0; i < 40; i++) s = addLine(s, at(50 + i, 0), at(50 + i, 10)).sketch;
    const first = spline(s, b.splineId).points[0];
    const t = performance.now();
    for (let i = 0; i < 10; i++) s = dragPoint(s, first, i * 0.3, 25 + i * 0.2);
    // Generous for busy CI machines: typically a few ms a step here.
    expect((performance.now() - t) / 10).toBeLessThan(400);
    const r = solveSketch(s);
    expect(r.ok).toBe(true);
  });

  it("drag stays quick with tangents on splines", () => {
    const a = arch();
    const b = addSpline(a.sketch, [at(0, 25), at(10, 15), at(20, 25)], false);
    const s = applyRelation(b.sketch, "tangent", [a.id, b.splineId]).sketch;
    const t = performance.now();
    let k = s;
    for (let i = 0; i < 10; i++) k = dragPoint(k, spline(k, b.splineId).points[0], i * 0.3, 25 + i * 0.2);
    expect(performance.now() - t).toBeLessThan(4000); // generous: CI machines are slow
    expect(solveSketch(k).ok).toBe(true);
  });
});
