/**
 * Engine tests, part 4: sweeps, lofts, text, sheet metal and surfaces.
 * Runs the real OpenCascade engine (in Node) against reference models and
 * checks volumes, positions and soundness. Shared set-up: tests/support/engineHelpers.ts.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMesh } from "../src/geometry/meshCheck";
import { GeometryEngine } from "../src/kernel/engine";
import type { Feature } from "../src/model/types";
import { addArc, addCircle, addLine, addRectangle } from "../src/sketch/ops";
import { addEllipse, addSpline, offsetCurves, splitAt, trimAt } from "../src/sketch/tools";
import { planeOnFace } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";
import { loadOpenCascade, feature, sketchFeature, extrudeFeature, relativeError, rectSketch, lineSketch, meshOf } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

let engine: GeometryEngine;
afterEach(() => engine?.dispose());

function build(features: Feature[]) {
  engine = new GeometryEngine();
  return engine.rebuild(features);
}

describe("sweep and loft", () => {
  it("lofts between ellipses (and a circle) without cutting them in two", () => {
    // An ellipse long along X at the bottom, one long along Y 20 up: one smooth side, a plain rim top and bottom.
    const low = sketchFeature({ kind: "default", name: "Top" }, addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 0 }, [0, 5]).sketch);
    const high = sketchFeature(planeOnFace([0, 0, 1], [0, 0, 20], "up"), addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 6, y: 0 }, [0, 12]).sketch);
    const lo: Feature = { ...feature("loft", {}), sections: [low.id, high.id] };
    const r = build([low, high, lo]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts[0].edgeRefs.map((e) => e.curve)).toEqual(["ELLIPSE", "ELLIPSE"]);
    expect(r.parts[0].faceRefs).toHaveLength(3);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
    // A circle up to an ellipse, turned: the same.
    const ring = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 8).sketch);
    const r2 = build([ring, high, { ...lo, sections: [ring.id, high.id] }]);
    expect(r2.featureErrors).toEqual({});
    expect(r2.parts[0].edgeRefs).toHaveLength(2);
    expect(r2.parts[0].faceRefs).toHaveLength(3);
    // As a surface: one face, two rims.
    const r3 = build([low, high, { ...lo, surface: true }]);
    expect(r3.featureErrors).toEqual({});
    expect(r3.parts[0].faceRefs).toHaveLength(1);
    expect(r3.parts[0].edgeRefs).toHaveLength(2);
  });

  it("sweeps a circle along an L-shaped path into a bent pipe", () => {
    // Path on Top: straight along +X for 40 mm.
    let path = emptySketch();
    path = addLine(path, { x: 0, y: 0 }, { x: 40, y: 0 }).sketch;
    const pathSk = sketchFeature({ kind: "default", name: "Top" }, path);
    // Profile on Right (the YZ plane) at the start of the path: a 6 mm circle round the origin.
    const profile = sketchFeature({ kind: "default", name: "Right" }, addCircle(emptySketch(), { x: 0, y: 0 }, 3).sketch);
    const sweep: Feature = { ...feature("sweep", {}), sketchRef: profile.id, pathRef: pathSk.id };
    const r = build([pathSk, profile, sweep]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    expect(relativeError(a.volume, Math.PI * 9 * 40)).toBeLessThan(0.02);
    expect(a.bounds?.max[0]).toBeCloseTo(40, 1);
    // Same sketch for both: explained.
    expect(build([pathSk, { ...sweep, sketchRef: pathSk.id }]).featureErrors[sweep.id]).toMatch(/different sketches/);
  });

  it("lofts from a square on Top to a smaller square higher up", () => {
    const base = sketchFeature({ kind: "default", name: "Top" }, rectSketch(-10, -10, 20, 20));
    const top = sketchFeature(planeOnFace([0, 0, 1], [0, 0, 10], "10 mm up"), rectSketch(-5, -5, 10, 10));
    const loftF: Feature = { ...feature("loft", {}), sections: [base.id, top.id] };
    const r = build([base, top, loftF]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    // A straight-sided frustum: h/3 (A1 + A2 + √(A1·A2)).
    expect(relativeError(a.volume, (10 / 3) * (400 + 100 + 200))).toBeLessThan(0.01);
    expect(build([base, { ...loftF, sections: [base.id] }]).featureErrors[loftF.id]).toMatch(/at least two/);
  });
});

describe("text", () => {
  it("makes solid letters, raised or engraved", () => {
    const t: Feature = { ...feature("text", { size: 10, depth: 2, x: 5, y: 5 }), text: { value: "Hi 8", plane: { kind: "default", name: "Top" }, bold: false, flip: false } };
    const r = build([t]);
    expect(r.featureErrors).toEqual({});
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.watertight).toBe(true);
    expect(a.bounds?.min[2]).toBeCloseTo(0, 6);
    expect(a.bounds?.max[2]).toBeCloseTo(2, 6);
    expect(a.bounds?.min[0]).toBeGreaterThan(4.9);
    expect(a.volume).toBeGreaterThan(20);
    // Engraved into the top of a block.
    const block = feature("box", { width: 60, depth: 30, height: 10 });
    const cut: Feature = { ...feature("text", { size: 10, depth: 1, x: 5, y: 10 }, "remove"), text: { value: "Hi", plane: planeOnFace([0, 0, 1], [0, 0, 10], "top"), bold: true, flip: true } };
    const e = build([block, cut]);
    expect(e.featureErrors).toEqual({});
    const v = analyzeMesh(e.parts[0].vertices, e.parts[0].triangles).volume;
    expect(v).toBeLessThan(60 * 30 * 10);
    expect(v).toBeGreaterThan(60 * 30 * 10 - 200);
    expect(build([{ ...t, text: { ...t.text!, value: "   " } }]).featureErrors[t.id]).toMatch(/Type some text/);
  });

  it("wraps round a round face, raised or engraved", () => {
    const rod = feature("cylinder", { diameter: 20, height: 30, x: 0, y: 0, z: 0 });
    const first = build([rod]);
    const side = first.parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "CYLINDRE")!;
    expect(side).toBeTruthy();
    const pick = { partId: rod.id, ref: side };
    const solidVolume = analyzeMesh(first.parts[0].vertices, first.parts[0].triangles).volume;
    const raised: Feature = { ...feature("text", { size: 6, depth: 1, x: 0, y: 0 }, "add"), text: { value: "ROD", plane: null, bold: true, flip: false, face: pick } };
    const r = build([rod, raised]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.volume).toBeGreaterThan(solidVolume + 5);
    // The letters stand about 1 mm proud, facing the front (−Y).
    expect(a.bounds!.min[1]).toBeLessThan(-10.5);
    expect(a.bounds!.min[1]).toBeGreaterThan(-11.5);
    expect(a.bounds!.max[1]).toBeLessThan(10.2);
    const engraved: Feature = { ...raised, operation: "remove", text: { ...raised.text!, flip: true } };
    const e = build([rod, engraved]);
    expect(e.featureErrors).toEqual({});
    const v = analyzeMesh(e.parts[0].vertices, e.parts[0].triangles).volume;
    expect(v).toBeLessThan(solidVolume - 5);
    expect(v).toBeGreaterThan(solidVolume - 300);
  });

  it("wraps a sketch's shapes round a round face (Wrap)", () => {
    const rod = feature("cylinder", { diameter: 20, height: 30, x: 0, y: 0, z: 0 });
    const first = build([rod]);
    const side = first.parts[0].faceRefs.find((f) => f.kind === "face" && f.surface === "CYLINDRE")!;
    const solidVolume = analyzeMesh(first.parts[0].vertices, first.parts[0].triangles).volume;
    // An 8 × 4 rectangle, and a small square beside it, drawn anywhere.
    let data = addRectangle(emptySketch(), { x: 100, y: 50 }, { x: 108, y: 54 }).sketch;
    data = addRectangle(data, { x: 110, y: 50 }, { x: 112, y: 52 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, data);
    const wrap: Feature = { ...feature("wrap", { depth: 1 }, "add"), sketchRef: sk.id, picks: [{ partId: rod.id, ref: side }] };
    const r = build([rod, sk, wrap]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    // Each shape on a flat patch 1 mm out from the surface where it touches (≈ 41 + 4 mm³), on the side facing the front.
    expect(a.volume).toBeGreaterThan(solidVolume + 35);
    expect(a.volume).toBeLessThan(solidVolume + 55);
    expect(a.bounds!.min[1]).toBeLessThan(-10.5);
    const engraved = build([rod, sk, { ...wrap, operation: "remove" }]);
    expect(engraved.featureErrors).toEqual({});
    // Cut down to a flat 1 mm in (≈ 23 + 4 mm³).
    const cutVolume = solidVolume - analyzeMesh(engraved.parts[0].vertices, engraved.parts[0].triangles).volume;
    expect(cutVolume).toBeGreaterThan(20);
    expect(cutVolume).toBeLessThan(35);
    // A band 40 wide (229° round the 20 mm rod) and 4 tall, raised 1: laid on narrow strips, it hugs the rod —
    // about the volume of that slice of a 1 mm thick ring (½ × 4 rad × (11² − 10²) × 4 = 168 mm³).
    const wide = sketchFeature({ kind: "default", name: "Top" }, addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 4 }).sketch);
    const band = build([rod, wide, { ...wrap, sketchRef: wide.id }]);
    expect(band.featureErrors).toEqual({});
    expect(band.parts).toHaveLength(1);
    const bandMesh = analyzeMesh(band.parts[0].vertices, band.parts[0].triangles);
    expect(bandMesh.volume - solidVolume).toBeGreaterThan(150);
    expect(bandMesh.volume - solidVolume).toBeLessThan(190);
    // It stays within 1 mm of the surface all round.
    const radii: number[] = [];
    for (let i = 0; i < band.parts[0].vertices.length; i += 3) radii.push(Math.hypot(band.parts[0].vertices[i], band.parts[0].vertices[i + 1]));
    expect(Math.max(...radii)).toBeLessThan(11.05);
    // More than once round: too wide.
    const tooWide = sketchFeature({ kind: "default", name: "Top" }, addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 70, y: 4 }).sketch);
    expect(build([rod, tooWide, { ...wrap, sketchRef: tooWide.id }]).featureErrors[wrap.id]).toMatch(/too wide/);
    expect(build([rod, sk, { ...wrap, picks: [] }]).featureErrors[wrap.id]).toMatch(/round face/);
  }, 120_000);
});

describe("splines and ellipses", () => {
  it("extrudes an ellipse, turned and tall or wide", () => {
    const turn = Math.PI / 6;
    const el = addEllipse(emptySketch(), { x: 5, y: 0 }, { x: 5 + 20 * Math.cos(turn), y: 20 * Math.sin(turn) }, [5 - 8 * Math.sin(turn), 8 * Math.cos(turn)]);
    expect(el.error).toBe(undefined);
    const sk = sketchFeature({ kind: "default", name: "Top" }, el.sketch);
    const r = build([sk, extrudeFeature(sk.id, 5)]);
    expect(r.featureErrors).toEqual({});
    const a = meshOf(r);
    expect(a.watertight).toBe(true);
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(Math.PI * 20 * 8 * 5, 1);
    // Width across x: 2·√((20 cos30)² + (8 sin30)²).
    expect(a.bounds!.max[0] - a.bounds!.min[0]).toBeCloseTo(2 * Math.hypot(20 * Math.cos(turn), 8 * Math.sin(turn)), 1);
    // The short axis drawn first works too.
    const tall = addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 4, y: 0 }, [0, 10]);
    const sk2 = sketchFeature({ kind: "default", name: "Front" }, tall.sketch);
    const r2 = build([sk2, extrudeFeature(sk2.id, 2)]);
    expect(r2.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(Math.PI * 4 * 10 * 2, 1);
  });

  it("extrudes shapes made by trimming, splitting and offsetting splines and ellipses", () => {
    // Half an ellipse: trim off its lower half with a line through the middle, then the line's ends outside it.
    const el = addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }, [0, 10]);
    const ln = addLine(el.sketch, { x: -30, y: 0 }, { x: 30, y: 0 });
    let half = trimAt(ln.sketch, el.ellipseId, { x: 0, y: -10 }).sketch;
    half = trimAt(half, ln.lineId, { x: -25, y: 0 }).sketch;
    half = trimAt(half, ln.lineId, { x: 25, y: 0 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, half);
    const r = build([sk, extrudeFeature(sk.id, 5)]);
    expect(r.featureErrors).toEqual({});
    expect(meshOf(r).watertight).toBe(true);
    expect(relativeError(engine.check("normal").parts[0].exactVolume!, (Math.PI * 20 * 10 * 5) / 2)).toBeLessThan(1e-9);

    // An arch closed by a line; split the arch in two (its pieces arrive and leave at different speeds): the same solid.
    const base = addLine(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 0 });
    const line = base.sketch.curves[0] as { p1: string; p2: string };
    const arch = addSpline(base.sketch, [{ x: 40, y: 0, snap: { kind: "point", id: line.p2 } }, { x: 30, y: 12 }, { x: 12, y: 9 }, { x: 0, y: 0, snap: { kind: "point", id: line.p1 } }], false);
    const whole = sketchFeature({ kind: "default", name: "Top" }, arch.sketch);
    build([whole, extrudeFeature(whole.id, 4)]);
    const v0 = engine.check("normal").parts[0].exactVolume!;
    const split = splitAt(arch.sketch, arch.splineId, { x: 21, y: 11 });
    expect(split.error).toBeUndefined();
    expect(split.sketch.curves.some((c) => c.type === "spline" && c.tangentsIn)).toBe(true);
    const sk2 = sketchFeature({ kind: "default", name: "Top" }, split.sketch);
    const r2 = build([sk2, extrudeFeature(sk2.id, 4)]);
    expect(r2.featureErrors).toEqual({});
    expect(relativeError(engine.check("normal").parts[0].exactVolume!, v0)).toBeLessThan(1e-9);

    // An ellipse offset outwards by 3: its area grows by perimeter × 3 + π·3².
    const e2 = addEllipse(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }, [0, 10]);
    const off = offsetCurves(e2.sketch, e2.ellipseId, { x: 0, y: 14 }, "3");
    expect(off.error).toBeUndefined();
    const onlyCopy = { ...off.sketch, curves: off.sketch.curves.filter((c) => c.id !== e2.ellipseId), constraints: [] };
    const sk3 = sketchFeature({ kind: "default", name: "Top" }, onlyCopy);
    const r3 = build([sk3, extrudeFeature(sk3.id, 2)]);
    expect(r3.featureErrors).toEqual({});
    let perimeter = 0;
    for (let i = 0; i < 100000; i++) {
      const t = ((i + 0.5) / 100000) * 2 * Math.PI;
      perimeter += Math.hypot(20 * Math.sin(t), 10 * Math.cos(t)) * ((2 * Math.PI) / 100000);
    }
    const area = Math.PI * 20 * 10 + perimeter * 3 + Math.PI * 9;
    expect(relativeError(engine.check("normal").parts[0].exactVolume!, area * 2)).toBeLessThan(1e-4);
  });

  it("extrudes a closed spline", () => {
    const sp = addSpline(emptySketch(), [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 25, y: 15 }, { x: 5, y: 20 }].map((q) => ({ ...q, snap: null })), true);
    const sk = sketchFeature({ kind: "default", name: "Top" }, sp.sketch);
    const r = build([sk, extrudeFeature(sk.id, 3)]);
    expect(r.featureErrors).toEqual({});
    expect(meshOf(r).watertight).toBe(true);
    expect(engine.check("normal").parts[0].geometryValid).toBe(true);
  });
});

describe("parts in other configurations (for assemblies)", () => {
  it("builds a Part Studio again with another configuration's sizes", async () => {
    engine = new GeometryEngine();
    const box = feature("box", { width: "w", depth: 10, height: 10 });
    const r = engine.rebuildStudios(
      [
        { id: "main", features: [box] },
        { id: "main@big", features: [box], variables: { w: 30 }, partSuffix: "@big" },
      ],
      { w: 10 },
    );
    expect(r.featureErrors).toEqual({});
    const plain = r.parts.find((p) => p.id === box.id)!;
    const big = r.parts.find((p) => p.id === `${box.id}@big`)!;
    expect(big.configuration).toBe("big");
    const width = (p: typeof plain) => {
      const a = analyzeMesh(p.vertices, p.triangles);
      return a.bounds!.max[0] - a.bounds!.min[0];
    };
    expect(width(plain)).toBeCloseTo(10, 4);
    expect(width(big)).toBeCloseTo(30, 4);
    // "All parts" (checks, exports, drawings of the Part Studio) means the ordinary ones.
    expect(engine.check("normal").parts.map((p) => p.partId)).toEqual([box.id]);
    // An assembly can place either.
    const step = await engine.exportStep([], undefined, [
      { id: "i1", partId: box.id, name: "Box <1>", position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      { id: "i2", partId: `${box.id}@big`, name: "Box <2>", position: [0, 50, 0], rotation: [0, 0, 0, 1] },
    ]);
    expect(step.partCount).toBe(2);
  });
});

describe("curve pattern", () => {
  it("repeats a feature along a sketched path", () => {
    const plate = feature("box", { width: 100, depth: 100, height: 5, x: 0, y: 0, z: 0 });
    const peg = feature("cylinder", { diameter: 4, height: 10, x: 10, y: 10, z: 5 }, "add");
    const path = addLine(emptySketch(), { x: 10, y: 10 }, { x: 90, y: 10 });
    const bend = addLine(path.sketch, { x: 90, y: 10, snap: { kind: "point", id: path.endId } }, { x: 90, y: 90 });
    const sk = sketchFeature({ kind: "default", name: "Top" }, bend.sketch);
    const pattern: Feature = { ...feature("curvePattern", { count: 5 }), operation: "add", pattern: { sources: [peg.id], axis: "x", flip: false }, pathRef: sk.id };
    const r = build([plate, peg, sk, pattern]);
    expect(r.featureErrors).toEqual({});
    const peg1 = Math.PI * 4 * 10;
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(100 * 100 * 5 + 5 * peg1, 0);
    // The last peg is at the far end of the path.
    const a = analyzeMesh(r.parts[0].vertices, r.parts[0].triangles);
    expect(a.bounds!.max[1]).toBeCloseTo(100, 3);
    const tops: number[] = [];
    const v = r.parts[0].vertices;
    for (let i = 0; i < v.length; i += 3) if (Math.abs(v[i + 2] - 15) < 1e-3) tops.push(v[i + 1]);
    expect(Math.max(...tops)).toBeCloseTo(92, 1);
    // Without a path it says so.
    expect(build([plate, peg, { ...pattern, pathRef: undefined }]).featureErrors[pattern.id]).toMatch(/path/);
  });

  it("follows a spline or a whole circle too", () => {
    const plate = feature("box", { width: 100, depth: 100, height: 5, x: -50, y: -50, z: 0 });
    const peg = feature("cylinder", { diameter: 4, height: 10, x: 30, y: 0, z: 5 }, "add");
    // Around a whole circle: 6 pegs, evenly spaced, all on the circle.
    const ring = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 30).sketch);
    const round: Feature = { ...feature("curvePattern", { count: 6 }), operation: "add", pattern: { sources: [peg.id], axis: "x", flip: false }, pathRef: ring.id };
    const r = build([plate, peg, ring, round]);
    expect(r.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(100 * 100 * 5 + 6 * Math.PI * 4 * 10, 0);
    // Along an open spline from the peg.
    const sp = addSpline(emptySketch(), [{ x: 30, y: 0 }, { x: 10, y: 20 }, { x: -20, y: 10 }, { x: -30, y: -30 }].map((q) => ({ ...q, snap: null })), false);
    const wavy = sketchFeature({ kind: "default", name: "Top" }, sp.sketch);
    const along: Feature = { ...round, pathRef: wavy.id, params: { count: "4" } };
    const r2 = build([plate, peg, wavy, along]);
    expect(r2.featureErrors).toEqual({});
    expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(100 * 100 * 5 + 4 * Math.PI * 4 * 10, 0);
    // The last peg sits on the spline's far end, (−30, −30).
    const v = r2.parts[0].vertices;
    const tops: [number, number][] = [];
    for (let i = 0; i < v.length; i += 3) if (Math.abs(v[i + 2] - 15) < 1e-3) tops.push([v[i], v[i + 1]]);
    expect(Math.min(...tops.map((t) => t[1]))).toBeCloseTo(-32, 1);
  });
});

describe("sweep paths", () => {
  const vol = () => engine.check("normal").parts[0].exactVolume!;
  it("sweeps along a whole circle (a ring), a spline, and from whichever end the profile is at", () => {
    // A 2 mm-radius circle round a 20 mm-radius circle: a torus, 2π·20 · π·2² mm³.
    const ring = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 20, y: 0 }, 20).sketch);
    const prof = sketchFeature({ kind: "default", name: "Front" }, addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const torus = build([ring, prof, { ...feature("sweep", {}), sketchRef: prof.id, pathRef: ring.id }]);
    expect(torus.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(2 * Math.PI * 20 * Math.PI * 4, 0);
    // A line then an arc, with the profile at the line's far end (x = 60): the sweep starts there.
    let d = lineSketch(60, 0, 30, 0);
    d = addArc(d, { x: 30, y: 0 }, { x: 0, y: 30 }, { x: 21.21, y: 21.21 }).sketch;
    const path = sketchFeature({ kind: "default", name: "Top" }, d);
    const end = sketchFeature(planeOnFace([1, 0, 0], [60, 0, 0], "end"), addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const fromEnd = build([path, end, { ...feature("sweep", {}), sketchRef: end.id, pathRef: path.id }]);
    expect(fromEnd.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo((30 + (Math.PI / 2) * 30) * Math.PI * 4, -1);
    // Along a spline.
    const sp = addSpline(emptySketch(), [{ x: 0, y: 0 }, { x: 20, y: 10 }, { x: 40, y: 0 }].map((q) => ({ ...q, snap: null })), false);
    const curvy = sketchFeature({ kind: "default", name: "Top" }, sp.sketch);
    const start = sketchFeature({ kind: "default", name: "Right" }, addCircle(emptySketch(), { x: 0, y: 0 }, 2).sketch);
    const r = build([curvy, start, { ...feature("sweep", {}), sketchRef: start.id, pathRef: curvy.id }]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("normal").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.exactVolume!).toBeGreaterThan(40 * Math.PI * 4);
  });
});

describe("sheet metal", () => {
  const vol = () => engine.check("normal").parts[0].exactVolume!;
  const sheet = (sketchRef: string, flipSide = false): Feature => ({
    id: "sm",
    name: "Sheet metal 1",
    type: "sheetMetal",
    operation: "new",
    suppressed: false,
    params: { thickness: "2", radius: "2", kFactor: "0.45" },
    sketchRef,
    ...(flipSide ? { flipSide: true } : {}),
  });

  it("explains what to do when the sketch has overlapping shapes", () => {
    let data = rectSketch(0, 0, 100, 50);
    data = addCircle(data, { x: 100, y: 25 }, 10).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, data);
    const r = build([sk, sheet(sk.id)]);
    expect(r.featureErrors.sm).toMatch(/overlap each other count separately: use Trim/);
  });

  it("still takes flanges after the part is moved or turned, and copies keep their flat pattern", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 100, 50));
    const plain = build([sk, sheet(sk.id)]);
    const edge = (r: ReturnType<typeof build>, x: number) => r.parts[0].edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[0] - x) < 1e-6 && Math.abs(e.b[0] - x) < 1e-6 && Math.abs(e.a[2] - 2) < 1e-6)!;
    const flange = (r: ReturnType<typeof build>, x: number): Feature => ({ id: "fl", name: "Flange 1", type: "flange", operation: "add", suppressed: false, params: { length: "30", angle: "90" }, picks: [{ partId: "sm", ref: edge(r, x) }] });
    build([sk, sheet(sk.id), flange(plain, 100)]);
    const expected = vol();
    // Moved 20 along X: its right edge is now at x = 120.
    const mv: Feature = { ...feature("transform", { dx: 20 }, "add"), transform: { partId: "sm", axis: "z", about: "centre", copy: false } };
    const moved = build([sk, sheet(sk.id), mv]);
    const r = build([sk, sheet(sk.id), mv, flange(moved, 120)]);
    expect(r.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(expected, 1);
    expect(r.parts[0].flat).toBeTruthy();
    // The move doesn't count as something the flat pattern leaves out.
    expect(r.parts[0].flat!.notShown ?? []).toEqual([]);
    // Turned 90° about its centre (50, 25): the old right edge now runs along X at y = 75.
    const turn: Feature = { ...feature("transform", { rz: 90 }, "add"), transform: { partId: "sm", axis: "z", about: "centre", copy: false } };
    const turned = build([sk, sheet(sk.id), turn]);
    const side = turned.parts[0].edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[1] - 75) < 1e-6 && Math.abs(e.b[1] - 75) < 1e-6 && Math.abs(e.a[2] - 2) < 1e-6)!;
    const r2 = build([sk, sheet(sk.id), turn, { ...flange(turned, 100), picks: [{ partId: "sm", ref: side }] }]);
    expect(r2.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(expected, 1);
    // A moved copy is sheet metal too.
    const copy = build([sk, sheet(sk.id), { ...mv, transform: { ...mv.transform!, copy: true } }]);
    expect(copy.parts.map((p) => !!p.flat)).toEqual([true, true]);
  });

  it("makes a flat sheet from a sketch, then bends a flange up off a picked edge", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 100, 50));
    const r1 = build([sk, sheet(sk.id)]);
    expect(r1.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(100 * 50 * 2, 3);
    // The right-hand edge (x = 100) along the sheet's top face.
    const p = r1.parts[0];
    const ref = p.edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[0] - 100) < 1e-6 && Math.abs(e.b[0] - 100) < 1e-6 && Math.abs(e.a[2] - 2) < 1e-6)!;
    expect(ref).toBeTruthy();
    const flange: Feature = { id: "fl", name: "Flange 1", type: "flange", operation: "add", suppressed: false, params: { length: "30", angle: "90" }, picks: [{ partId: p.id, ref }] };
    const r2 = build([sk, sheet(sk.id), flange]);
    expect(r2.featureErrors).toEqual({});
    // The plate, a quarter-round bend (radii 2 and 4) and a 26 mm straight wall, all 50 mm long and 2 mm thick.
    expect(vol()).toBeCloseTo(10000 + (Math.PI / 4) * (16 - 4) * 50 + 26 * 50 * 2, 1);
    expect(r2.parts).toHaveLength(1);
    // Its flat pattern: 100 wide plus the bend allowance (π/2 × (2 + 0.45 × 2)) and the 26 mm wall.
    const flat = r2.parts[0].flat!;
    expect(flat.bendLines).toHaveLength(1);
    const xs = flat.outline.map((q) => q[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100 + (Math.PI / 2) * (2 + 0.45 * 2) + 26, 4);
    expect(flat.notShown).toEqual([]);
    // Laid out flat for the 3D view: as wide as the flat pattern, and still 2 mm thick.
    const flatMesh = engine.unfold(p.id)!;
    expect(flatMesh).toBeTruthy();
    const fx = Array.from(flatMesh.vertices).filter((_, i) => i % 3 === 0);
    const fz = Array.from(flatMesh.vertices).filter((_, i) => i % 3 === 2);
    expect(Math.max(...fx) - Math.min(...fx)).toBeCloseTo(100 + (Math.PI / 2) * (2 + 0.45 * 2) + 26, 3);
    expect(Math.max(...fz) - Math.min(...fz)).toBeCloseTo(2, 6);
    expect(engine.unfold("nowhere")).toBe(null);
    // Shortened by 10 at each end: 30 wide, with a 2 × 2 relief notch (through the 2 mm sheet) beside each end.
    build([sk, sheet(sk.id), { ...flange, params: { length: "30", angle: "90", inset: "10" } }]);
    expect(vol()).toBeCloseTo(10000 - 2 * 8 + (Math.PI / 4) * (16 - 4) * 30 + 26 * 30 * 2, 1);
    // Flanges on the right and top edges with closed corners: the right one laps the top one's end, the top one butts against it.
    const topRef = p.edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE" && Math.abs(e.a[1] - 50) < 1e-6 && Math.abs(e.b[1] - 50) < 1e-6 && Math.abs(e.a[2] - 2) < 1e-6)!;
    const both: Feature = { ...flange, picks: [{ partId: p.id, ref }, { partId: p.id, ref: topRef }], closeCorners: true };
    const r7 = build([sk, sheet(sk.id), both]);
    expect(r7.featureErrors).toEqual({});
    expect(r7.parts).toHaveLength(1);
    expect(vol()).toBeCloseTo(10000 + (Math.PI / 4) * 12 * (50 + 100) + 26 * 2 * (54 + 102), 1);
    expect(r7.parts[0].flat!.bendLines).toHaveLength(2);
    // The same two flanges with a round corner relief instead: a little less metal, and the flat pattern outlined round it.
    const relieved = build([sk, sheet(sk.id), { ...both, closeCorners: undefined, cornerRelief: "round" }]);
    expect(relieved.featureErrors).toEqual({});
    const withRelief = vol();
    build([sk, sheet(sk.id), { ...both, closeCorners: undefined }]);
    const without = vol();
    expect(withRelief).toBeLessThan(without - 10);
    expect(relieved.parts[0].flat!.boundary?.length).toBeGreaterThan(0);
    // A closed hem on the same edge: a half-turn bend (inside radius 0.05) and an 8 mm lip folded back over the sheet.
    const hem: Feature = { id: "hm", name: "Hem 1", type: "hem", operation: "add", suppressed: false, params: { length: "8", gap: "0", inset: "0" }, picks: [{ partId: p.id, ref }] };
    const r6 = build([sk, sheet(sk.id), hem]);
    expect(r6.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(10000 + (Math.PI / 2) * (2.05 * 2.05 - 0.05 * 0.05) * 50 + 8 * 50 * 2, 1);
    expect(r6.parts).toHaveLength(1);
    expect(r6.parts[0].flat!.bendLines).toHaveLength(1);
    // A hole drilled through the plate afterwards (a 10 mm cylinder taken away) shows in the flat pattern, round its centre.
    const drill = feature("cylinder", { diameter: 10, height: 20, x: 50, y: 25, z: -5 }, "remove");
    const r4 = build([sk, sheet(sk.id), flange, drill]);
    expect(r4.featureErrors).toEqual({});
    const cut = r4.parts[0].flat!;
    expect(cut.notShown).toEqual([]);
    expect(cut.cuts!.length).toBeGreaterThan(8);
    for (const [a, b] of cut.cuts!) for (const q of [a, b]) expect(Math.hypot(q[0] - 50, q[1] - 25)).toBeCloseTo(5, 1);
    // From an open outline: an L (50 along, then 30 up), 20 deep. Two flats (46 and 26) and a quarter bend.
    let L = addLine(emptySketch(), { x: 0, y: 0, snap: null }, { x: 50, y: 0, snap: null }).sketch;
    L = addLine(L, { x: 50, y: 0, snap: null }, { x: 50, y: 30, snap: null }).sketch;
    const lsk = sketchFeature({ kind: "default", name: "Top" }, L);
    const r5 = build([lsk, { ...sheet(lsk.id), params: { thickness: "2", radius: "2", kFactor: "0.45", depth: "20" } }]);
    expect(r5.featureErrors).toEqual({});
    expect(vol()).toBeCloseTo(20 * 2 * (46 + 26) + (Math.PI / 4) * (16 - 4) * 20, 1);
    expect(r5.parts[0].flat!.bendLines).toHaveLength(1);
    // A tab sketched on the sheet's top face, reaching 20 mm past its right edge: 20 × 30 more sheet, in the flat pattern too.
    const onTop = { kind: "face" as const, origin: [0, 0, 2] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number], label: "Top face" };
    const tsk = sketchFeature(onTop, rectSketch(90, 10, 30, 30));
    const tab: Feature = { id: "tb", name: "Tab 1", type: "tab", operation: "add", suppressed: false, params: {}, sketchRef: tsk.id };
    const r8 = build([sk, sheet(sk.id), tsk, tab]);
    expect(r8.featureErrors).toEqual({});
    expect(r8.parts).toHaveLength(1);
    expect(vol()).toBeCloseTo(10000 + 20 * 30 * 2, 1);
    const tabFlat = r8.parts[0].flat!;
    const tx = tabFlat.boundary!.flat().map((q) => q[0]);
    expect(Math.max(...tx)).toBeCloseTo(120, 2);
    // The line where the tab joins the sheet isn't one to cut.
    expect(tabFlat.boundary!.some(([a, b]) => Math.abs(a[0] - 100) < 1e-3 && Math.abs(b[0] - 100) < 1e-3 && Math.min(a[1], b[1]) >= 10 - 1e-3 && Math.max(a[1], b[1]) <= 40 + 1e-3)).toBe(false);
    // A tab off in mid-air.
    const away = sketchFeature(onTop, rectSketch(200, 10, 10, 10));
    expect(build([sk, sheet(sk.id), away, { ...tab, sketchRef: away.id }]).featureErrors.tb).toMatch(/doesn't touch/);
    // Not a sheet metal part: a clear message.
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const r3 = build([box]);
    const boxEdge = r3.parts[0].edgeRefs.find((e) => e.kind === "edge" && e.curve === "LINE")!;
    expect(build([box, { ...flange, picks: [{ partId: r3.parts[0].id, ref: boxEdge }] }]).featureErrors.fl).toMatch(/isn't a sheet metal part/);
  });
});

describe("surfaces", () => {
  const area = (m: { vertices: Float32Array; triangles: Uint32Array }) => {
    let a = 0;
    const v = m.vertices;
    const t = m.triangles;
    for (let i = 0; i + 2 < t.length; i += 3) {
      const [p, q, r] = [t[i], t[i + 1], t[i + 2]].map((k) => [v[3 * k], v[3 * k + 1], v[3 * k + 2]]);
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      a += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    }
    return a;
  };
  /** An open L: along X 20, then up Y 10. */
  const openL = () => {
    let d = addLine(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }).sketch;
    d = addLine(d, { x: 20, y: 0 }, { x: 20, y: 10 }).sketch;
    return d;
  };

  it("extrudes an open outline into a surface, and a closed one into a skin with no ends", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, openL());
    const ex: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const r = build([sk, ex]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].surface).toBe(true);
    expect(r.parts[0].name).toBe("Surface 1");
    // Two walls: 20 × 5 and 10 × 5, no top or bottom.
    expect(area(r.parts[0])).toBeCloseTo(150, 2);
    expect(r.parts[0].faceRefs).toHaveLength(2);
    const box = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 10, 10));
    const skin = build([box, { ...extrudeFeature(box.id, 10), surface: true }]);
    expect(skin.featureErrors).toEqual({});
    expect(area(skin.parts[0])).toBeCloseTo(400, 2);
    // The check says what it is, and it has no volume.
    const c = engine.check("coarse");
    expect(c.parts[0].surface).toBe(true);
    expect(c.parts[0].exactVolume).toBe(0);
    // A solid made afterwards doesn't add to the surface: there's no solid yet.
    const onto = feature("box", { width: 5, depth: 5, height: 5, x: 30 }, "add");
    const later = build([box, { ...extrudeFeature(box.id, 10), surface: true }, onto]);
    expect(later.featureErrors[onto.id]).toMatch(/no part to add to/);
    const fresh = build([box, { ...extrudeFeature(box.id, 10), surface: true }, { ...onto, operation: "new" }]);
    expect(fresh.featureErrors).toEqual({});
    expect(fresh.parts.map((p) => !!p.surface)).toEqual([true, false]);
  });

  it("revolves, sweeps and lofts outlines into surfaces", () => {
    // A line 10 from the axis, spun right round: a tube of radius 10, 20 long (no ends).
    const d = addLine(emptySketch(), { x: 10, y: 0 }, { x: 10, y: 20 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Front" }, d);
    const rev: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: sk.id, revolve: { axis: "vertical", flip: false }, surface: true };
    const r = build([sk, rev]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts[0].surface).toBe(true);
    expect(area(r.parts[0])).toBeCloseTo(2 * Math.PI * 10 * 20, -1);
    // Loft: two open arcs of different sizes on parallel planes.
    const arcA = sketchFeature({ kind: "default", name: "Top" }, addArc(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 6 }).sketch);
    const arcB = sketchFeature(planeOnFace([0, 0, 1], [0, 0, 20], "up"), addArc(emptySketch(), { x: -20, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 12 }).sketch);
    const lo: Feature = { ...feature("loft", {}), sections: [arcA.id, arcB.id], surface: true };
    const l = build([arcA, arcB, lo]);
    expect(l.featureErrors).toEqual({});
    expect(l.parts[0].surface).toBe(true);
    expect(area(l.parts[0])).toBeGreaterThan(400);
    // Sweep: a line (up Z, on the Right plane at the start of the path) swept along a straight path: a flat strip 40 × 8.
    const prof = sketchFeature({ kind: "default", name: "Right" }, addLine(emptySketch(), { x: 0, y: 0 }, { x: 0, y: 8 }).sketch);
    const path = sketchFeature({ kind: "default", name: "Top" }, addLine(emptySketch(), { x: 0, y: 0 }, { x: 40, y: 0 }).sketch);
    const sw: Feature = { ...feature("sweep", {}), sketchRef: prof.id, pathRef: path.id, surface: true };
    const s = build([prof, path, sw]);
    expect(s.featureErrors).toEqual({});
    expect(s.parts[0].surface).toBe(true);
    expect(area(s.parts[0])).toBeCloseTo(320, 1);
  });

  it("extends a surface past its edges, and splits (trims) one with a plane", () => {
    // A flat wall 20 wide, 5 tall, from a line along X extruded up.
    const sk = sketchFeature({ kind: "default", name: "Top" }, addLine(emptySketch(), { x: 0, y: 0 }, { x: 20, y: 0 }).sketch);
    const wall: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const first = build([sk, wall]);
    const p = first.parts[0];
    const topEdge = p.edgeRefs.find((e) => e.curve === "LINE" && Math.abs(e.a[2] - 5) < 1e-6 && Math.abs(e.b[2] - 5) < 1e-6)!;
    expect(topEdge).toBeTruthy();
    const ext: Feature = { ...feature("extendSurface", { distance: 3 }), picks: [{ partId: p.id, ref: topEdge }] };
    const r = build([sk, wall, ext]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].surface).toBe(true);
    // 20 × 8 now, in one piece (two faces sewn together).
    expect(area(r.parts[0])).toBeCloseTo(160, 2);
    const zs = Array.from(r.parts[0].vertices).filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(8, 4);
    expect(analyzeMesh(r.parts[0].vertices, r.parts[0].triangles).pieces).toBe(1);
    // Split the wall at z = 2 with a plane, keeping the top: 20 × 3.
    const split: Feature = { ...feature("split", {}), splitDef: { partId: p.id, plane: planeOnFace([0, 0, 1], [0, 0, 2], "cut"), keep: "front", picking: "plane" } };
    const cut = build([sk, wall, split]);
    expect(cut.featureErrors).toEqual({});
    expect(cut.parts).toHaveLength(1);
    expect(area(cut.parts[0])).toBeCloseTo(60, 2);
    const both = build([sk, wall, { ...split, splitDef: { ...split.splitDef!, keep: "both" } }]);
    expect(both.featureErrors).toEqual({});
    expect(both.parts.map((x) => [!!x.surface, Math.round(area(x))])).toEqual([
      [true, 40],
      [true, 60],
    ]);
    expect(both.parts[1].name).toBe("Surface 1 (cut)");
  });

  it("fills openings, encloses surfaces into a solid, and thickens or offsets a surface", () => {
    const box = sketchFeature({ kind: "default", name: "Top" }, rectSketch(0, 0, 10, 10));
    const skin: Feature = { ...extrudeFeature(box.id, 10), surface: true };
    const first = build([box, skin]);
    const p = first.parts[0];
    // The four edges round the top opening (at z = 10) and the bottom (z = 0).
    const ring = (z: number) => p.edgeRefs.filter((e) => e.curve === "LINE" && Math.abs(e.a[2] - z) < 1e-6 && Math.abs(e.b[2] - z) < 1e-6).map((ref) => ({ partId: p.id, ref }));
    expect(ring(10), JSON.stringify(p.edgeRefs)).toHaveLength(4);
    const top: Feature = { ...feature("fill", {}), picks: ring(10) };
    const bottom: Feature = { ...feature("fill", {}), picks: ring(0) };
    const filled = build([box, skin, top, bottom]);
    expect(filled.featureErrors).toEqual({});
    expect(filled.parts.map((x) => x.name)).toEqual(["Surface 1", "Surface 2", "Surface 3"]);
    expect(area(filled.parts[1])).toBeCloseTo(100, 3);
    // Enclose the three into a 10 mm cube.
    const faceOf = (part: (typeof filled.parts)[number]) => ({ partId: part.id, ref: part.faceRefs[0] });
    const enc: Feature = { ...feature("enclose", {}), picks: filled.parts.map(faceOf) };
    const closed = build([box, skin, top, bottom, enc]);
    expect(closed.featureErrors).toEqual({});
    expect(closed.parts).toHaveLength(1);
    expect(closed.parts[0].surface).toBeUndefined();
    expect(closed.parts[0].name).toBe("Part 1");
    expect(analyzeMesh(closed.parts[0].vertices, closed.parts[0].triangles).volume).toBeCloseTo(1000, 1);
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo(1000, 3);
    // A missing side: can't be enclosed.
    const gap: Feature = { ...enc, picks: [faceOf(filled.parts[0]), faceOf(filled.parts[1])] };
    expect(build([box, skin, top, bottom, gap]).featureErrors[gap.id]).toMatch(/gap/);
    // Thicken the open skin 1 mm outwards: a 12 × 12 × 10 box less the 10 × 10 × 10 inside.
    const thick: Feature = { ...feature("thicken", { thickness: 1 }, "new"), picks: [faceOf(p)] };
    const t = build([box, skin, thick]);
    expect(t.featureErrors).toEqual({});
    expect(t.parts).toHaveLength(1);
    expect(t.parts[0].surface).toBeUndefined();
    // The skin's faces point inwards here, so 1 mm in: 10 × 10 × 10 less the 8 × 8 × 10 inside. Flipped, outwards: 12 × 12 × 10 less 10 × 10 × 10.
    const thickCheck = engine.check("coarse").parts[0];
    expect(thickCheck.geometryValid).toBe(true);
    expect(thickCheck.exactVolume!).toBeCloseTo(360, 3);
    expect(thickCheck.mesh.watertight).toBe(true);
    build([box, skin, { ...thick, flipSide: true }]);
    expect(engine.check("coarse").parts[0].exactVolume!).toBeCloseTo(440, 3);
    // Offset the skin 2 mm: a 14 × 14 (or, the other way, 6 × 6) skin, 10 tall, as another surface; minus goes the other way.
    const off: Feature = { ...feature("offsetSurface", { distance: 2 }), picks: [faceOf(p)] };
    const o = build([box, skin, off]);
    expect(o.featureErrors).toEqual({});
    expect(o.parts).toHaveLength(2);
    expect(o.parts[1].surface).toBe(true);
    const a1 = area(o.parts[1]);
    const back = area(build([box, skin, { ...off, params: { distance: "-2" } }]).parts[1]);
    const [small, big] = [a1, back].sort((x, y) => x - y);
    expect(small).toBeCloseTo(240, 0);
    // Outwards the corners are rounded off, so a little under 4 × 14 × 10.
    expect(big).toBeGreaterThan(500);
    expect(big).toBeLessThan(561);
  });

  it("thickens open and curved surfaces into real solids, either side", () => {
    // A flat wall 20 × 5 → a 20 × 5 × 1 slab.
    const sk = sketchFeature({ kind: "default", name: "Top" }, lineSketch(0, 0, 20, 0));
    const wall: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const w = build([sk, wall]).parts[0];
    const pick = { partId: w.id, ref: w.faceRefs[0] };
    const slab = build([sk, wall, { ...feature("thicken", { thickness: 1 }, "new"), picks: [pick] }]);
    expect(slab.featureErrors).toEqual({});
    expect(slab.parts.map((p) => [p.name, !!p.surface, p.faceRefs.length])).toEqual([["Part 1", false, 6]]);
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo(100, 3);
    expect(engine.check("coarse").parts[0].mesh.watertight).toBe(true);
    // A round skin (radius 10, 20 tall) → a tube 1 mm thick, one way or the other.
    const c = sketchFeature({ kind: "default", name: "Top" }, addCircle(emptySketch(), { x: 0, y: 0 }, 10).sketch);
    const skin: Feature = { ...extrudeFeature(c.id, 20), surface: true };
    const cp = { partId: skin.id, ref: build([c, skin]).parts[0].faceRefs[0] };
    const tube = build([c, skin, { ...feature("thicken", { thickness: 1 }, "new"), picks: [cp] }]);
    expect(tube.featureErrors).toEqual({});
    expect(tube.parts[0].faceRefs).toHaveLength(4);
    const v1 = engine.check("coarse").parts[0].exactVolume!;
    build([c, skin, { ...feature("thicken", { thickness: 1 }, "new"), picks: [cp], flipSide: true }]);
    const v2 = engine.check("coarse").parts[0].exactVolume!;
    expect([v1, v2].sort((a, b) => a - b).map((v) => Math.round(v))).toEqual([Math.round(Math.PI * (100 - 81) * 20), Math.round(Math.PI * (121 - 100) * 20)]);
    // Added onto a solid: the tube fuses with a block under it.
    const block = feature("box", { width: 10, depth: 10, height: 10, x: -5, y: -5, z: -10 });
    const onto = build([block, c, skin, { ...feature("thicken", { thickness: 1 }, "add"), picks: [cp] }]);
    expect(onto.featureErrors).toEqual({});
    expect(onto.parts.map((p) => [p.name, !!p.surface])).toEqual([["Part 1", false], ["Surface 1", true]]);
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo(1000 + v1, 1);
    // A closed skin (a ball): plus is outwards whichever way its faces point.
    const arc = sketchFeature({ kind: "default", name: "Front" }, addArc(emptySketch(), { x: 0, y: -10 }, { x: 0, y: 10 }, { x: 10, y: 0 }).sketch);
    const ball: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: arc.id, revolve: { axis: "vertical", flip: false }, surface: true };
    const bp = { partId: ball.id, ref: build([arc, ball]).parts[0].faceRefs[0] };
    build([arc, ball, { ...feature("thicken", { thickness: 1 }, "new"), picks: [bp] }]);
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo((4 / 3) * Math.PI * (1331 - 1000), 1);
    build([arc, ball, { ...feature("thicken", { thickness: 1 }, "new"), picks: [bp], flipSide: true }]);
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo((4 / 3) * Math.PI * (1000 - 729), 1);
    // Two separate walls in one surface: both thickened.
    let two = lineSketch(0, 0, 20, 0);
    two = addLine(two, { x: 0, y: 30 }, { x: 20, y: 30 }).sketch;
    const tw = sketchFeature({ kind: "default", name: "Top" }, two);
    const pair: Feature = { ...extrudeFeature(tw.id, 5), surface: true };
    const pp = { partId: pair.id, ref: build([tw, pair]).parts[0].faceRefs[0] };
    expect(build([tw, pair, { ...feature("thicken", { thickness: 1 }, "new"), picks: [pp] }]).featureErrors).toEqual({});
    expect(engine.check("coarse").parts[0].exactVolume).toBeCloseTo(200, 3);
  });

  it("moves, copies, mirrors, patterns, rounds and trims surfaces like parts", () => {
    let l = lineSketch(0, 0, 20, 0);
    l = addLine(l, { x: 20, y: 0 }, { x: 20, y: 10 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Top" }, l);
    const wall: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const first = build([sk, wall]);
    const p = first.parts[0];
    // Move it 10 along X; a copy is another surface.
    const mv: Feature = { ...feature("transform", { dx: 10 }, "add"), transform: { partId: wall.id, axis: "z", about: "centre", copy: false } };
    const moved = build([sk, wall, mv]);
    expect(moved.featureErrors).toEqual({});
    expect(Math.min(...Array.from(moved.parts[0].vertices).filter((_, i) => i % 3 === 0))).toBeCloseTo(10, 4);
    const copied = build([sk, wall, { ...mv, transform: { ...mv.transform!, copy: true } }]);
    expect(copied.featureErrors).toEqual({});
    expect(copied.parts.map((x) => [x.name, !!x.surface])).toEqual([["Surface 1", true], ["Surface 1 (copy)", true]]);
    // Mirror across the Right plane (x = 0): twice the skin, one surface.
    const mi: Feature = { ...feature("mirror", {}, "add"), mirror: { sources: [wall.id], plane: { kind: "default", name: "Right" } } };
    const mirrored = build([sk, wall, mi]);
    expect(mirrored.featureErrors).toEqual({});
    expect(mirrored.parts).toHaveLength(1);
    expect(area(mirrored.parts[0])).toBeCloseTo(300, 2);
    // Three in a row along Y.
    const lp: Feature = { ...feature("linearPattern", { count: 3, spacing: 10 }, "add"), pattern: { sources: [wall.id], axis: "y", flip: false } };
    const row = build([sk, wall, lp]);
    expect(row.featureErrors).toEqual({});
    expect(area(row.parts[0])).toBeCloseTo(450, 2);
    // Round the corner where the two walls meet (radius 2): the corner strip replaced by a quarter round.
    const corner = p.edgeRefs.find((e) => e.kind === "edge" && Math.abs(e.mid[0] - 20) < 1e-6 && Math.abs(e.mid[1]) < 1e-6)!;
    const rounded = build([sk, wall, { ...feature("fillet", { radius: 2 }, "add"), picks: [{ partId: wall.id, ref: corner }] }]);
    expect(rounded.featureErrors).toEqual({});
    expect(rounded.parts[0].surface).toBe(true);
    expect(area(rounded.parts[0])).toBeCloseTo(150 - 4 * 5 + Math.PI * 5, 1);
    const bevelled = build([sk, wall, { ...feature("chamfer", { distance: 2 }, "add"), picks: [{ partId: wall.id, ref: corner }] }]);
    expect(bevelled.featureErrors).toEqual({});
    expect(area(bevelled.parts[0])).toBeCloseTo(150 - 4 * 5 + Math.SQRT2 * 2 * 5, 1);
    // Delete face takes a face out of a surface; booleans and Shell say surfaces have no inside.
    const side = p.faceRefs.find((f) => Math.abs(f.center[0] - 20) < 1e-6)!;
    const fewer = build([sk, wall, { ...feature("deleteFace", {}), picks: [{ partId: wall.id, ref: side }] }]);
    expect(fewer.featureErrors).toEqual({});
    expect(area(fewer.parts[0])).toBeCloseTo(100, 2);
    const box = feature("box", { width: 10, depth: 10, height: 10, y: -5 });
    const union: Feature = { ...feature("boolean", {}), booleanDef: { op: "union", targets: [wall.id, box.id], tools: [], keepTools: false } };
    expect(build([sk, wall, box, union]).featureErrors[union.id]).toMatch(/Surface 1 is a surface/);
    const shell: Feature = { ...feature("shell", { thickness: 1 }, "remove"), picks: [{ partId: wall.id, ref: side }] };
    expect(build([sk, wall, shell]).featureErrors[shell.id]).toMatch(/Use Thicken/);
    // Fill needs a closed ring.
    const topEdge = p.edgeRefs.find((e) => e.kind === "edge" && Math.abs(e.mid[2] - 5) < 1e-6)!;
    const gap: Feature = { ...feature("fill", {}), picks: [{ partId: wall.id, ref: topEdge }] };
    expect(build([sk, wall, gap]).featureErrors[gap.id]).toMatch(/gap/);
  });

  it("splits a part, or a surface, with a surface", () => {
    // A 20 × 20 × 20 block, and a curved surface (an arc bulging up to z = 14 at the middle) extruded right through it along Y.
    const block = feature("box", { width: 20, depth: 20, height: 20 });
    const arcSk = sketchFeature({ kind: "default", name: "Front" }, addArc(emptySketch(), { x: -5, y: 10 }, { x: 25, y: 10 }, { x: 10, y: 14 }).sketch);
    const curve: Feature = { ...extrudeFeature(arcSk.id, 50, { end: "symmetric" }), surface: true };
    const first = build([block, arcSk, curve]);
    expect(first.featureErrors).toEqual({});
    expect(first.parts.map((p) => [p.name, !!p.surface])).toEqual([["Part 1", false], ["Surface 1", true]]);
    const split: Feature = { ...feature("split", {}), splitDef: { partId: block.id, toolPartId: curve.id, plane: { kind: "default", name: "Top" }, keep: "both", picking: "plane" } };
    const both = build([block, arcSk, curve, split]);
    expect(both.featureErrors).toEqual({});
    expect(both.parts.map((p) => [p.name, !!p.surface])).toEqual([["Part 1", false], ["Surface 1", true], ["Part 2", false]]);
    const vols = engine.check("coarse").parts.filter((p) => !p.surface).map((p) => p.exactVolume!);
    expect(vols[0] + vols[1]).toBeCloseTo(8000, 2);
    // The top piece is the smaller: the arc sits above z = 10.
    expect(Math.min(...vols)).toBeLessThan(3200);
    expect(Math.max(...vols)).toBeGreaterThan(4800);
    // One side only: a single part, the surface left alone.
    const top = build([block, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, keep: "front" } }]);
    const bottom = build([block, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, keep: "back" } }]);
    expect(top.parts.map((p) => p.name)).toEqual(["Part 1", "Surface 1"]);
    expect(bottom.parts.map((p) => p.name)).toEqual(["Part 1", "Surface 1"]);
    const sideVols = [0, 0];
    build([block, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, keep: "front" } }]);
    sideVols[0] = engine.check("coarse").parts[0].exactVolume!;
    build([block, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, keep: "back" } }]);
    sideVols[1] = engine.check("coarse").parts[0].exactVolume!;
    expect(sideVols[0] + sideVols[1]).toBeCloseTo(8000, 2);
    expect(sideVols[0]).not.toBe(sideVols[1]);
    // A surface that stops short can't split.
    const short: Feature = { ...extrudeFeature(arcSk.id, 10, { end: "symmetric" }), surface: true };
    const stops = build([block, arcSk, short, { ...split, splitDef: { ...split.splitDef!, toolPartId: short.id } }]);
    expect(stops.featureErrors[split.id]).toMatch(/doesn't go right through/);
    // A surface split by a surface: a flat wall (x = 0..20, 20 tall) cut by the same arc into two skins.
    const wallSk = sketchFeature({ kind: "default", name: "Top" }, lineSketch(0, 10, 20, 10));
    const wall: Feature = { ...extrudeFeature(wallSk.id, 20), surface: true };
    const skins = build([wallSk, wall, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, partId: wall.id } }]);
    expect(skins.featureErrors).toEqual({});
    expect(skins.parts.map((p) => [p.name, !!p.surface])).toEqual([["Surface 1", true], ["Surface 2", true], ["Surface 1 (cut)", true]]);
    expect(area(skins.parts[0]) + area(skins.parts[2])).toBeCloseTo(400, 1);
    // Can't split with a solid, or with itself.
    const solidTool = build([block, arcSk, curve, { ...split, splitDef: { ...split.splitDef!, partId: curve.id, toolPartId: block.id } }]);
    expect(solidTool.featureErrors[split.id]).toMatch(/is a solid/);
  });

  it("sweeps ruled strips from edges, straight or tilted", () => {
    // The top edges of a 10 mm cube, swept 5 up (square to Top): four walls, one surface.
    const box = feature("box", { width: 10, depth: 10, height: 10 });
    const p = build([box]).parts[0];
    const top = p.edgeRefs.filter((e) => e.kind === "edge" && Math.abs(e.mid[2] - 10) < 1e-6).map((ref) => ({ partId: box.id, ref }));
    expect(top).toHaveLength(4);
    const ruled: Feature = { ...feature("ruled", { distance: 5, angle: 0 }), picks: top, neutral: { kind: "default", name: "Top" } };
    const r = build([box, ruled]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((x) => [x.name, !!x.surface])).toEqual([["Part 1", false], ["Surface 1", true]]);
    expect(area(r.parts[1])).toBeCloseTo(200, 2);
    expect(Math.max(...Array.from(r.parts[1].vertices).filter((_, i) => i % 3 === 2))).toBeCloseTo(15, 4);
    expect(analyzeMesh(r.parts[1].vertices, r.parts[1].triangles).pieces).toBe(1);
    // Flipped: down into the cube, to z = 5.
    const down = build([box, { ...ruled, flipSide: true }]);
    expect(Math.min(...Array.from(down.parts[1].vertices).filter((_, i) => i % 3 === 2))).toBeCloseTo(5, 4);
    // Tilted 45°: each strip leans over, 5 long, so it rises 5 cos 45°.
    const tilted = build([box, { ...ruled, params: { distance: "5", angle: "45" } }]);
    expect(tilted.featureErrors).toEqual({});
    expect(Math.max(...Array.from(tilted.parts[1].vertices).filter((_, i) => i % 3 === 2))).toBeCloseTo(10 + 5 * Math.SQRT1_2, 3);
    // One edge along the direction can't be tilted.
    const upright = p.edgeRefs.find((e) => e.kind === "edge" && Math.abs(e.a[2] - e.b[2]) > 1)!;
    const bad: Feature = { ...ruled, params: { distance: "5", angle: "30" }, picks: [{ partId: box.id, ref: upright }] };
    expect(build([box, bad]).featureErrors[bad.id]).toMatch(/runs along the direction/);
    // Edges of a surface work too, and the strip is a surface that can be thickened.
    const sk = sketchFeature({ kind: "default", name: "Top" }, addArc(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }).sketch);
    const curve: Feature = { ...extrudeFeature(sk.id, 5), surface: true };
    const cp = build([sk, curve]).parts[0];
    const rim = cp.edgeRefs.find((e) => e.kind === "edge" && e.curve === "CIRCLE" && Math.abs(e.mid[2] - 5) < 1e-6)!;
    const strip: Feature = { ...feature("ruled", { distance: 4, angle: 0 }), picks: [{ partId: curve.id, ref: rim }], neutral: { kind: "default", name: "Top" } };
    const rs = build([sk, curve, strip]);
    expect(rs.featureErrors).toEqual({});
    expect(area(rs.parts[1])).toBeCloseTo(Math.PI * 10 * 4, 0);
  });

  it("thickens a revolved skin whose faces meet at an awkward angle (rounding the join)", () => {
    // An arc closed by its chord, spun round a construction line 5 mm to one side: a curved face meeting a
    // cylinder at a corner. Sharp-cornered offsetting fails on this, so the join is rounded instead.
    let d = addLine(emptySketch(), { x: -5, y: -15 }, { x: -5, y: 15 }).sketch;
    d = { ...d, curves: d.curves.map((c) => ({ ...c, construction: true })) };
    d = addArc(d, { x: 0, y: -10 }, { x: 0, y: 10 }, { x: 10, y: 0 }).sketch;
    d = addLine(d, { x: 0, y: 10 }, { x: 0, y: -10 }).sketch;
    const sk = sketchFeature({ kind: "default", name: "Front" }, d);
    const rev: Feature = { ...feature("revolve", { angle: 360 }), sketchRef: sk.id, revolve: { axis: d.curves[0].id, flip: false }, surface: true };
    const first = build([sk, rev]);
    expect(first.featureErrors).toEqual({});
    expect(first.parts[0].faceRefs).toHaveLength(2);
    const th: Feature = { ...feature("thicken", { thickness: 1 }, "new"), picks: [{ partId: rev.id, ref: first.parts[0].faceRefs[0] }] };
    const r = build([sk, rev, th]);
    expect(r.featureErrors).toEqual({});
    const check = engine.check("coarse").parts[0];
    expect(check.geometryValid).toBe(true);
    expect(check.exactVolume!).toBeGreaterThan(1000);
    expect(check.mesh.watertight).toBe(true);
  });

  it("draws a surface in drawing views, including section views", () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, addArc(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }).sketch);
    build([sk, { ...extrudeFeature(sk.id, 20), surface: true }]);
    const [front, cut] = engine.project([], undefined, ["front"], true, [{ key: "section:A", host: "front", a: [0, 0.5], b: [1, 0.5], flip: false }]);
    expect(front.visible.length).toBeGreaterThan(0);
    // Cut half way up: the arc that's left, seen from above.
    expect(cut.kind).toBe("section:A");
    expect(cut.bounds).not.toBeNull();
    expect(cut.visible.length + cut.circles.length).toBeGreaterThan(0);
  });

  it("exports surfaces to STEP and reads them back as surfaces", async () => {
    const sk = sketchFeature({ kind: "default", name: "Top" }, addArc(emptySketch(), { x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }).sketch);
    const half: Feature = { ...extrudeFeature(sk.id, 20), surface: true };
    const box = feature("box", { width: 5, depth: 5, height: 5, x: 30 });
    build([sk, half, box]);
    const { step, partCount } = await engine.exportStep([]);
    expect(partCount).toBe(2);
    const imp: Feature = { ...feature("import", {}), import: { fileName: "s.step", format: "step", data: new TextDecoder().decode(step), units: "mm" } };
    const r = build([imp]);
    expect(r.featureErrors).toEqual({});
    expect(r.parts.map((p) => [p.name, !!p.surface])).toEqual([["Part 1", false], ["Surface 1", true]]);
    expect(area(r.parts[1])).toBeCloseTo(Math.PI * 10 * 20, 0);
    // Surfaces alone come in too, but can't be added to a part.
    build([sk, half]);
    const only = new TextDecoder().decode((await engine.exportStep([])).step);
    const alone = build([{ ...imp, import: { ...imp.import!, data: only } }]);
    expect(alone.parts.map((p) => [p.name, !!p.surface])).toEqual([["Surface 1", true]]);
    const onto: Feature = { ...feature("import", {}, "add"), import: { ...imp.import!, data: only } };
    expect(build([box, onto]).featureErrors[onto.id]).toMatch(/only surfaces/);
  });
});
