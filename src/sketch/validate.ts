/** Checks sketch data loaded from storage, keeping only what's well-formed. */
import { parsePick } from "../geometry/topoRef";
import type { SketchPlane, Vec3 } from "./planes";
import { DIMENSION_TYPES, type ConstraintType, type CurveLink, type SketchConstraint, type SketchCurve, type SketchData, type SketchImage, type SketchPoint, type SketchText } from "./types";

const RELATIONS = new Set<string>([
  "coincident",
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "equal",
  "tangent",
  "concentric",
  "midpoint",
  "symmetric",
  "pointOnLine",
  "pointOnCircle",
  "pointOnCurve",
  "fix",
  "patternCopy",
  "patternMove",
  "normal",
  "curvature",
]);

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const vec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(num);

export function parsePlane(raw: unknown): SketchPlane | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.kind === "default" && (p.name === "Top" || p.name === "Front" || p.name === "Right")) return { kind: "default", name: p.name };
  if (p.kind === "face" && vec3(p.origin) && vec3(p.u) && vec3(p.v)) {
    return {
      kind: "face",
      origin: p.origin,
      u: p.u,
      v: p.v,
      label: typeof p.label === "string" ? p.label : "Face",
      ...(typeof p.planeRef === "string" ? { planeRef: p.planeRef } : {}),
      ...(parseFacePick(p.face) ?? {}),
    };
  }
  return null;
}

export function parseSketchData(raw: unknown): SketchData | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.points) || !Array.isArray(d.curves) || !Array.isArray(d.constraints)) return null;

  const points: SketchPoint[] = [];
  for (const p of d.points as Record<string, unknown>[]) {
    if (!p || !str(p.id) || !num(p.x) || !num(p.y)) return null;
    points.push({ id: p.id, x: p.x, y: p.y, ...(p.standalone === true ? { standalone: true } : {}) });
  }
  const curves: SketchCurve[] = [];
  for (const c of d.curves as Record<string, unknown>[]) {
    if (!c || !str(c.id)) return null;
    const construction = c.construction === true;
    const link = parseLink(c.link);
    if (c.type === "line" && str(c.p1) && str(c.p2)) curves.push({ id: c.id, type: "line", p1: c.p1, p2: c.p2, construction, ...link });
    else if (c.type === "circle" && str(c.center) && num(c.radius)) curves.push({ id: c.id, type: "circle", center: c.center, radius: c.radius, construction, ...link });
    else if (c.type === "arc" && str(c.center) && str(c.start) && str(c.end))
      curves.push({ id: c.id, type: "arc", center: c.center, start: c.start, end: c.end, construction, ...link });
    else if (c.type === "spline" && Array.isArray(c.points) && c.points.length >= 2 && c.points.every(str))
      curves.push({
        id: c.id,
        type: "spline",
        points: c.points as string[],
        closed: c.closed === true && c.points.length >= 3 && typeof c.conic !== "number",
        construction,
        ...(typeof c.conic === "number" && c.conic > 0 && c.conic < 1 && c.points.length === 3 ? { conic: c.conic } : {}),
        ...splineHandlesOf(c.tangents, c.points as string[]),
        ...splineHandlesOf(c.tangentsIn, c.points as string[], "tangentsIn"),
        ...(Array.isArray(c.offsetParams) && c.offsetParams.length === c.points.length && c.offsetParams.every(num) ? { offsetParams: c.offsetParams as number[] } : {}),
      });
    else if (c.type === "ellipse" && str(c.center) && str(c.major) && str(c.minor))
      curves.push({
        id: c.id,
        type: "ellipse",
        center: c.center,
        major: c.major,
        minor: c.minor,
        construction,
        // Part of an ellipse: both ends, or it's the whole ellipse.
        ...(str(c.start) && str(c.end) ? { start: c.start, end: c.end } : {}),
      });
    else return null;
  }
  const constraints: SketchConstraint[] = [];
  for (const c of d.constraints as Record<string, unknown>[]) {
    if (!c || !str(c.id) || typeof c.type !== "string") return null;
    if (!RELATIONS.has(c.type) && !DIMENSION_TYPES.has(c.type as ConstraintType)) return null;
    if (!Array.isArray(c.refs) || !c.refs.every(str)) return null;
    const out: SketchConstraint = { id: c.id, type: c.type as ConstraintType, refs: c.refs as string[] };
    if (typeof c.value === "string") out.value = c.value;
    if (Array.isArray(c.extra) && c.extra.every(num)) out.extra = c.extra as number[];
    const lo = c.labelOffset as Record<string, unknown> | undefined;
    if (lo && num(lo.x) && num(lo.y)) out.labelOffset = { x: lo.x, y: lo.y };
    if (c.driven === true && DIMENSION_TYPES.has(out.type)) out.driven = true;
    constraints.push(out);
  }
  const out: SketchData = { points, curves, constraints };
  // Text and pictures (newer sketches only); ones that aren't well-formed are left out.
  const texts = Array.isArray(d.texts) ? (d.texts as unknown[]).map(parseText).filter((t): t is SketchText => !!t) : [];
  if (texts.length) out.texts = texts;
  const images = Array.isArray(d.images) ? (d.images as unknown[]).map(parseImage).filter((m): m is SketchImage => !!m) : [];
  if (images.length) out.images = images;
  return out;
}

/** A curve's link to a part edge (or, for Intersect, to where the sketch cuts the part). */
function parseLink(raw: unknown): { link?: CurveLink } {
  const linked = parsePick(raw);
  if (linked?.ref.kind !== "edge") return {};
  const cut = (raw as Record<string, unknown>).cut;
  if (!cut || typeof cut !== "object") return { link: linked };
  const face = parsePick({ partId: linked.partId, ref: (cut as Record<string, unknown>).face });
  return { link: { ...linked, cut: face?.ref.kind === "face" ? { face: face.ref } : {} } };
}

function parseText(raw: unknown): SketchText | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (!str(t.id) || !str(t.anchor) || typeof t.value !== "string" || !num(t.size) || t.size <= 0) return null;
  return {
    id: t.id,
    anchor: t.anchor,
    value: t.value,
    size: t.size,
    angle: num(t.angle) ? t.angle : 0,
    font: t.font === "bold" ? "bold" : "regular",
    ...(t.anchorAt === "centre" ? { anchorAt: "centre" as const } : {}),
    construction: t.construction === true,
  };
}

/** The longest picture (as a data: URL) a file may hold. */
export const MAX_PICTURE_CHARS = 6 * 1024 * 1024;

function parseImage(raw: unknown): SketchImage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  // Pictures are made small when they're added; a huge one (from a hand-edited file) is left out.
  if (!str(m.id) || typeof m.src !== "string" || !m.src.startsWith("data:image/") || m.src.length > MAX_PICTURE_CHARS) return null;
  if (!num(m.x) || !num(m.y) || !num(m.width) || !num(m.height) || m.width <= 0 || m.height <= 0) return null;
  const opacity = num(m.opacity) ? Math.max(0, Math.min(1, m.opacity)) : 0.5;
  return { id: m.id, src: m.src, x: m.x, y: m.y, width: m.width, height: m.height, opacity, ...(typeof m.name === "string" && m.name ? { name: m.name } : {}) };
}

/** The face a sketch sits on (so its edges can be used), if saved and well-formed. */
function parseFacePick(raw: unknown): { face: NonNullable<Extract<SketchPlane, { kind: "face" }>["face"]> } | null {
  const pick = parsePick(raw);
  return pick?.ref.kind === "face" ? { face: pick } : null;
}

/** A spline's saved handles, keeping only those for its own points and with two finite numbers. */
function splineHandlesOf(raw: unknown, points: string[], key: "tangents" | "tangentsIn" = "tangents"): { tangents?: Record<string, [number, number]>; tangentsIn?: Record<string, [number, number]> } {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, [number, number]> = {};
  for (const [id, t] of Object.entries(raw as Record<string, unknown>)) {
    if (points.includes(id) && Array.isArray(t) && t.length === 2 && t.every((v) => typeof v === "number" && Number.isFinite(v))) out[id] = [t[0], t[1]];
  }
  return Object.keys(out).length ? { [key]: out } : {};
}
