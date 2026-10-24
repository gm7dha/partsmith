/**
 * Sweep (a profile carried along a path) and loft (a smooth solid joining
 * outlines on different sketches), with OpenCascade.
 */
import { genericSweep, loft, type Shape3D, type Wire } from "replicad";

import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { findChains, findRegions, type Segment } from "../sketch/regions";
import { chosenRegions, type AreaPick } from "../sketch/areas";
import type { SketchData } from "../sketch/types";
import { loopWire, release, segmentsWire } from "./extrude";

type Vec3 = [number, number, number];

/** The same run of curves walked the other way. */
function reversed(segments: Segment[]): Segment[] {
  return [...segments].reverse().map((sg): Segment => {
    if (sg.kind === "line") return { kind: "line", from: sg.to, to: sg.from };
    if (sg.kind === "arc") return { kind: "arc", from: sg.to, mid: sg.mid, to: sg.from };
    if (sg.kind === "bezier") return { kind: "bezier", from: sg.to, c1: sg.c2, c2: sg.c1, to: sg.from };
    if (sg.kind === "ellipseArc") return { ...sg, from: sg.to, to: sg.from };
    return sg;
  });
}

const endsOf = (segments: Segment[]): [[number, number], [number, number]] | null => {
  const a = segments[0];
  const b = segments[segments.length - 1];
  if (!("from" in a) || !("to" in b)) return null;
  return [a.from, b.to];
};

/**
 * The path a sweep follows: the sketch's curves (lines, arcs, splines,
 * ellipses, circles) joined end to end into one run, open or closed. An open
 * run starts from the end nearest `near` (where the profile sits), if given.
 */
export function pathWire(plane: SketchPlane, data: SketchData, near?: Vec3): Wire {
  const { chains, problems } = findChains(data);
  if (chains.length === 0) {
    throw new Error(problems.length ? `The path must be one connected run of curves, with no branches. ${problems.join(" ")}` : "The path sketch has no lines or curves.");
  }
  if (chains.length > 1 || problems.length) throw new Error("The path must be one connected run of lines and curves, with no branches or separate pieces.");
  const frame = planeFrame(plane);
  let segments = chains[0].segments;
  const ends = endsOf(segments);
  if (near && ends && !chains[0].closed) {
    const d = (p: [number, number]) => {
      const w = toWorld(frame, p[0], p[1]);
      return Math.hypot(w[0] - near[0], w[1] - near[1], w[2] - near[2]);
    };
    if (d(ends[1]) < d(ends[0]) - 1e-9) segments = reversed(segments);
  }
  return segmentsWire(segments, frame, 0);
}

/** A point on a sketch's first closed shape (or first run), in 3D: where a sweep's profile sits. */
export function profileAt(plane: SketchPlane, data: SketchData): Vec3 | undefined {
  const { chains } = findChains(data);
  const first = chains[0]?.segments[0];
  if (!first) return undefined;
  const p = "from" in first ? first.from : first.center;
  return toWorld(planeFrame(plane), p[0], p[1]);
}

/** Carry each closed shape of the profile sketch along the path (holes stay holes). */
export function sweepSketch(profilePlane: SketchPlane, profile: SketchData, pathPlane: SketchPlane, path: SketchData, areas?: AreaPick[]): Shape3D {
  const { regions, problems } = chosenRegions(profile, areas, "sweep");
  if (regions.length === 0) throw new Error(`The profile sketch has no closed shapes.${problems.length ? ` ${problems.join(" ")}` : ""}`);
  const spine = pathWire(pathPlane, path, profileAt(profilePlane, profile));
  const frame = planeFrame(profilePlane);
  const sweepOne = (wire: Wire): Shape3D => {
    try {
      return genericSweep(wire, spine, { transitionMode: "round", forceProfileSpineOthogonality: false });
    } catch {
      throw new Error("Couldn't sweep the profile along that path. Check the profile sits at the start of the path and is small enough for its bends.");
    } finally {
      release(wire);
    }
  };
  try {
    let result: Shape3D | null = null;
    for (const region of regions) {
      let solid = sweepOne(loopWire(region.outer, frame, 0));
      for (const hole of region.holes) {
        const cutter = sweepOne(loopWire(hole, frame, 0));
        const next = solid.cut(cutter);
        release(solid, cutter);
        solid = next;
      }
      if (!result) result = solid;
      else {
        const merged: Shape3D = result.fuse(solid);
        release(result, solid);
        result = merged;
      }
    }
    return result!;
  } finally {
    release(spine);
  }
}

/** Which way a lone circle or ellipse starts from its centre (an ellipse at its long axis; a circle along the sketch's X). */
export function loopStart(segments: Segment[], frame: ReturnType<typeof planeFrame>): [number, number, number] | undefined {
  if (segments.length !== 1) return undefined;
  const s = segments[0];
  const a = s.kind === "ellipse" ? s.angle + (s.rx >= s.ry ? 0 : Math.PI / 2) : s.kind === "circle" ? 0 : null;
  if (a === null) return undefined;
  const { u, v } = frame;
  return [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)];
}

/** A smooth solid passing through one closed shape on each of the sketches, in order. */
export function loftSketches(sections: { plane: SketchPlane; data: SketchData; name: string }[]): Shape3D {
  if (sections.length < 2) throw new Error("Pick at least two sketches to loft between.");
  const wires: Wire[] = [];
  try {
    let start: [number, number, number] | undefined;
    for (const s of sections) {
      const { regions } = findRegions(s.data);
      if (regions.length !== 1) throw new Error(`${s.name} needs exactly one closed shape to loft through (it has ${regions.length}).`);
      if (regions[0].holes.length) throw new Error(`${s.name}'s shape has a hole in it — lofts can only join plain outlines for now.`);
      const frame = planeFrame(s.plane);
      // Whole circles and ellipses all start the same way round, so the loft doesn't cut them in two to line them up.
      start ??= loopStart(regions[0].outer.segments, frame);
      wires.push(loopWire(regions[0].outer, frame, 0, start));
    }
    try {
      return loft(wires, { ruled: false });
    } catch {
      throw new Error("Couldn't loft between those shapes. Try sketches on parallel planes, or outlines with the same number of sides.");
    }
  } finally {
    release(...wires);
  }
}
