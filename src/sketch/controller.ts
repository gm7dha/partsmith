/**
 * Sketch tools: turns pointer events (already converted to sketch mm by the
 * viewport) into sketch edits, and keeps the live preview (rubber-band line,
 * snap marker) for the viewport to draw.
 */
import { useStore, type SketchTool } from "../model/store";
import { hitTest, inferOrientation, type Hit } from "./hit";
import { dimensionLayout, offsetFor } from "./layout";
import {
  addArc,
  addCircle,
  addDimension,
  addLine,
  addPoint,
  addRectangle,
  circleThrough,
  curveById,
  dimensionFor,
  dimensionSpecAt,
  dragArcRim,
  dragCircleRim,
  dragCurve,
  dragPoint,
  pointPos,
  ellipsePoints,
  splinePath,
  pointsSharingCurve,
  radiusOf,
  setSplineHandle,
  splineHandleEnds,
  type Placed,
  type SplineHandleEnd,
} from "./ops";
import {
  addCentreRectangle,
  addPolygon,
  polygonCorners,
  addAlignedRectangle,
  addCentreArc,
  addEllipse,
  addSlot,
  addThreePointCircle,
  alignedWidth,
  addSpline,
  addConic,
  addTangentArc,
  filletCorner,
  mirrorCurves,
  offsetCurves,
  patternTransform,
  readTransformSettings,
  transformMove,
  readPatternSettings,
  tangentArcCentre,
  tangentAt,
  trimAt,
  extendAt,
  splitAt,
} from "./tools";
import { ORIGIN_ID, type SketchData } from "./types";
import { addText, imageAt, imageById, readTextSettings, textAt, textById } from "./sketchText";
import { isRefId, refSketch, type RefEdge } from "./links";
import { attachPoint, bringIn, hintFor, pickAt, snapAt, type SnapResult } from "./snaps";
import type { Snap } from "./ops";
import { splinePolyline } from "./spline";
import { ellipseFrom, ellipsePolyline, minorPointFor } from "./ellipse";
import { rectOf, sketchItemsInBox } from "../viewport/boxSelect";

export interface SketchPointer {
  /** Sketch coordinates (mm). */
  x: number;
  y: number;
  /** Millimetres per screen pixel at the current zoom. */
  mmPerPx: number;
  shift: boolean;
  ctrl: boolean;
  /** Screen position across the view (px), for telling which way a box was dragged. */
  screenX?: number;
}

/** Temporary shapes drawn while a tool is in progress. */
export type PreviewShape =
  | { kind: "line"; a: [number, number]; b: [number, number] }
  /** A faint guide showing what the pointer has lined up with. */
  | { kind: "guide"; a: [number, number]; b: [number, number] }
  | { kind: "circle"; c: [number, number]; r: number }
  | { kind: "arc"; c: [number, number]; r: number; a0: number; a1: number };

export interface SketchTransient {
  hover: Hit | null;
  preview: PreviewShape[];
  /** Where the pointer has snapped to (drawn as a small marker). */
  snap: [number, number] | null;
  /** "H" / "V" shown while a line is snapping horizontal or vertical. */
  inference: { at: [number, number]; text: string } | null;
  /** Items picked so far by the dimension tool. */
  pending: string[];
  /** Small markers: the middle of the line, or the centre of the circle or arc, under the pointer. */
  hints?: [number, number][];
}

const POINT_PX = 9;
const CURVE_PX = 6;
const DRAG_PX = 3;
/** How close (px) a dragged point must come to another to snap onto it. */
const SNAP_PX = 14;

interface DragState {
  kind: "point" | "curve" | "rim" | "handle" | "image" | "none";
  id: string;
  start: SketchData;
  startX: number;
  startY: number;
  moved: boolean;
  additive: boolean;
  hit: Hit | null;
  startScreenX?: number;
  /** Dragging from empty space draws a selection box: its far corner and whether it was dragged leftwards. */
  box?: { x: number; y: number; crossing: boolean };
  /** Dragging a point: what it has snapped onto (a point, a line's middle, a part edge's corner), joined when the drag ends. */
  snapTo?: Snap | null;
  /** Dragging a spline handle: which one. */
  handle?: SplineHandleEnd;
}

export class SketchController {
  private transient: SketchTransient = { hover: null, preview: [], snap: null, inference: null, pending: [] };
  /** Clicks collected so far by the current drawing tool. */
  private placed: Placed[] = [];
  private drag: DragState | null = null;
  /** Points the pointer has passed over while drawing, most recent first (to line up with). */
  private acquired: string[] = [];
  private lastTool: SketchTool | null = null;
  /** Which kind of dimension the placing preview last showed. */
  private previewKind: string | null = null;
  private readonly listeners = new Set<(t: SketchTransient) => void>();

  onChange(fn: (t: SketchTransient) => void): () => void {
    this.listeners.add(fn);
    fn(this.transient);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<SketchTransient>) {
    this.transient = { ...this.transient, ...patch };
    for (const fn of this.listeners) fn(this.transient);
  }

  // ---------------------------------------------------------------------------
  // Store access

  private get state() {
    return useStore.getState();
  }

  private get data(): SketchData | null {
    return this.state.editing?.draft.sketch?.data ?? null;
  }

  /** Edges of the part face the sketch is on (found on the latest rebuild). */
  private get refs(): RefEdge[] {
    const id = this.state.editing?.draft.id;
    return (id && this.state.sketchLinks?.[id]?.edges) || [];
  }

  /** What's under the pointer, part edges of the face included (their stand-in ids start "ref:"). */
  private pickAt(e: SketchPointer): Hit | null {
    const d = this.data;
    if (!d) return null;
    return pickAt(d, e.x, e.y, POINT_PX * e.mmPerPx, CURVE_PX * e.mmPerPx, this.refs);
  }

  /** A line's middle or a circle's centre to mark for whatever's hovered. */
  private hintsFor(hit: Hit | null): [number, number][] {
    const d = this.data;
    if (!d || hit?.kind !== "curve") return [];
    const virtual = isRefId(hit.id);
    const s = virtual ? refSketch(this.refs) : d;
    const c = curveById(s, hit.id);
    const h = c ? hintFor(s, c) : null;
    return h ? [h] : [];
  }

  /** Bring a picked part edge into the sketch (as a reference) and give its real id; the sketch's own ids come back as they are. */
  private realId(id: string): string | null {
    const d = this.data;
    if (!d || !isRefId(id)) return id;
    const r = bringIn(d, id, this.refs);
    if (r.error) {
      this.state.setSketchMessage(r.error, "info");
      return null;
    }
    this.state.updateSketch(r.sketch, { record: true });
    return r.id;
  }

  private get tool(): SketchTool {
    const tool = this.state.sketch?.tool ?? "select";
    if (tool !== this.lastTool) {
      // Switching tools abandons anything half-drawn.
      this.lastTool = tool;
      this.placed = [];
      this.acquired = [];
      this.transient = { ...this.transient, preview: [], inference: null, pending: [] };
    }
    return tool;
  }

  private commit(result: { sketch: SketchData; error?: string }, selection?: string[]): boolean {
    if (result.error) {
      this.state.setSketchMessage(result.error, "error");
      return false;
    }
    this.state.updateSketch(result.sketch, { record: true, selection });
    this.state.setSketchMessage(null);
    return true;
  }

  /**
   * Just after a shape is drawn, offer its sizes (like Onshape): add each
   * dimension and open the first one's value box. Enter keeps it (with
   * whatever was typed), Esc or carrying on drawing drops it.
   */
  private offerDimensions(groups: string[][]): void {
    let data = this.data;
    if (!data) return;
    const ids: string[] = [];
    for (const refs of groups) {
      const r = addDimension(data, refs);
      // Sizes already set by something else aren't offered.
      if (r.error || r.driven) continue;
      data = r.sketch;
      ids.push(r.dimensionId);
    }
    if (!ids.length) return;
    this.state.updateSketch(data, { record: false });
    this.state.offerDimensions(ids);
  }

  /**
   * Mirror tool: the first click picks the line to mirror about (if shapes
   * were already selected, they're mirrored straight away); each click after
   * that mirrors the clicked line, arc or circle. Esc finishes.
   */
  private mirrorClick(e: SketchPointer): void {
    const d = this.data!;
    const hit = this.hitAt(e);
    const axis = this.transient.pending[0];
    if (!axis) {
      const c = hit?.kind === "curve" ? curveById(d, hit.id) : undefined;
      if (c?.type !== "line") {
        this.state.setSketchMessage("First click the straight line to mirror about (a construction line works well).", "info");
        return;
      }
      this.emit({ pending: [c.id] });
      const chosen = (this.state.sketch?.selection ?? []).filter((id) => id !== c.id && d.curves.some((k) => k.id === id));
      if (chosen.length) {
        const r = mirrorCurves(d, c.id, chosen);
        if (this.commit(r, r.curveIds)) this.state.setSketchMessage(`Mirrored ${chosen.length === 1 ? "1 shape" : `${chosen.length} shapes`}. Click more to mirror them too, or Esc to finish.`, "info");
        return;
      }
      this.state.setSketchMessage("Now click the lines, arcs and circles to mirror. Esc when done.", "info");
      return;
    }
    if (hit?.kind !== "curve" || hit.id === axis) {
      this.state.setSketchMessage("Click a line, arc or circle to mirror it, or Esc to finish.", "info");
      return;
    }
    const r = mirrorCurves(d, axis, [hit.id]);
    if (this.commit(r, r.curveIds)) this.state.setSketchMessage("Mirrored. Click more to mirror them too, or Esc to finish.", "info");
    this.emit({ hover: null });
  }

  /**
   * Pattern tool: click lines, arcs and circles to choose what to repeat (and,
   * for a circular pattern, a point to go round); the sketch panel's button
   * makes the copies.
   */
  private patternClick(e: SketchPointer): void {
    const st = this.state;
    const moving = this.tool === "sketchTransform";
    const circular = !moving && st.sketch?.patternKind === "circular";
    // A circular pattern's centre can be any point: a sketch point, a circle's centre, a line's end, or a corner of the face.
    const picked = circular ? this.pickAt(e) : null;
    if (!moving && st.sketch?.patternKind === "linear" && st.sketch.patternDirectionPick) {
      const over = this.pickAt(e);
      const s = over && isRefId(over.id) ? refSketch(this.refs) : this.data!;
      const line = over?.kind === "curve" ? curveById(s, over.id) : undefined;
      if (line?.type !== "line") {
        st.setSketchMessage("Click a straight line (or a straight edge of the face) to set the direction.", "info");
        return;
      }
      const [a, b] = [pointPos(s, line.p1), pointPos(s, line.p2)];
      const angle = Math.round(((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) * 100) / 100;
      // A line of the sketch itself: the copies follow it if it turns (a part's edge just sets the angle).
      const lineId = over && !isRefId(over.id) ? line.id : undefined;
      st.setSketchOptions({ patternAngle: String(Object.is(angle, -0) ? 0 : angle), patternDirectionPick: false, patternLine: lineId });
      st.setSketchMessage(
        `Direction set along that line (${angle}°)${lineId ? " — the copies will follow the line if it turns" : ""}. Type 180 more to go the other way.`,
        "info",
      );
      this.emit({ preview: this.patternPreview() });
      return;
    }
    const hit = picked?.kind === "point" ? picked : this.hitAt(e);
    if (hit?.kind === "point" && circular) {
      const id = this.realId(hit.id);
      if (!id) return;
      st.setSketchOptions({ patternCentre: id });
      st.setSketchMessage("Centre chosen. Click the shapes to repeat, then Make pattern in the sketch panel. The copies follow if the centre moves.", "info");
    } else if (hit?.kind === "curve") {
      const sel = st.sketch?.selection ?? [];
      st.setSketchSelection(sel.includes(hit.id) ? sel.filter((x) => x !== hit.id) : [...sel, hit.id]);
      st.setSketchMessage(null);
    } else {
      st.setSketchMessage(
        moving ? "Click the lines, arcs and circles to move, then Move (or Copy) in the sketch panel." : "Click the lines, arcs and circles to repeat, then Make pattern in the sketch panel.",
        "info",
      );
      return;
    }
    this.emit({ preview: this.patternPreview() });
  }

  /** Faint copies showing where the pattern tool would put things. */
  private patternPreview(): PreviewShape[] {
    const d = this.data;
    const session = this.state.sketch;
    if (!d || !session) return [];
    const sources = session.selection.map((id) => curveById(d, id)).filter((c) => !!c);
    if (!sources.length) return [];
    let moves: ((p: [number, number]) => [number, number])[];
    if (this.tool === "sketchTransform") {
      const t = readTransformSettings(session);
      if (typeof t === "string") return [];
      moves = [transformMove(d, sources, t)];
    } else {
      const opts = readPatternSettings(d, session);
      if (typeof opts === "string" || !(opts.count >= 2 && opts.count <= 200)) return [];
      moves = Array.from({ length: Math.round(opts.count) - 1 }, (_, i) => patternTransform(opts, i + 1));
    }
    const out: PreviewShape[] = [];
    for (const move of moves) {
      const at = (id: string) => move(pointPos(d, id));
      for (const c of sources) {
        if (c.type === "line") out.push({ kind: "line", a: at(c.p1), b: at(c.p2) });
        else if (c.type === "circle") out.push({ kind: "circle", c: at(c.center), r: c.radius });
        else if (c.type === "spline" || c.type === "ellipse") {
          // Moving is rigid, so the curve drawn out moves point by point.
          const pts = (c.type === "spline" ? splinePath(d, c) : ellipsePoints(d, c)).map(move);
          for (let k = 0; k + 1 < pts.length; k++) out.push({ kind: "line", a: pts[k], b: pts[k + 1] });
        } else {
          const cc = at(c.center);
          const s0 = at(c.start);
          const s1 = at(c.end);
          out.push({ kind: "arc", c: cc, r: radiusOf(d, c), a0: Math.atan2(s0[1] - cc[1], s0[0] - cc[0]), a1: Math.atan2(s1[1] - cc[1], s1[0] - cc[0]) });
        }
      }
    }
    return out;
  }

  /** Redraw the pattern preview (after its settings change in the panel). */
  refreshPreview(): void {
    if (this.tool === "sketchPattern" || this.tool === "sketchTransform") this.emit({ preview: this.patternPreview() });
  }

  // ---------------------------------------------------------------------------
  // Snapping

  private hitAt(e: SketchPointer, ignore?: Set<string>): Hit | null {
    const d = this.data;
    if (!d) return null;
    return hitTest(d, e.x, e.y, POINT_PX * e.mmPerPx, CURVE_PX * e.mmPerPx, { ignore });
  }

  /** Where the pointer snaps to while drawing (points, middles of lines, part edges, lining up, onto curves). */
  private snapAt(e: SketchPointer): SnapResult {
    return snapAt(this.data!, e.x, e.y, { pointTol: POINT_PX * e.mmPerPx, curveTol: CURVE_PX * e.mmPerPx, acquired: this.acquired, refs: this.refs });
  }

  /** The spline handle end under the pointer, if any (handles show on selected splines). */
  private handleAt(e: SketchPointer): SplineHandleEnd | null {
    const d = this.data;
    if (!d) return null;
    const tol = POINT_PX * e.mmPerPx;
    let best: SplineHandleEnd | null = null;
    let bestD = tol;
    for (const h of splineHandleEnds(d, this.state.sketch?.selection ?? [])) {
      const dist = Math.hypot(h.at[0] - e.x, h.at[1] - e.y);
      if (dist <= bestD) {
        bestD = dist;
        best = h;
      }
    }
    return best;
  }

  /** Where a click lands, snapped to points, the origin, middles of lines, part edges or curves. */
  private placeAt(e: SketchPointer): Placed {
    return this.snapAt(e).placed;
  }

  private snapMarker(p: Placed): [number, number] | null {
    return p.snap ? [p.x, p.y] : null;
  }

  // ---------------------------------------------------------------------------
  // Pointer events

  pointerDown(e: SketchPointer): void {
    const d = this.data;
    if (!d) return;
    const tool = this.tool;
    if (tool === "select") return this.selectDown(e);
    if (tool === "dimension") return this.dimensionClick(e);
    if (tool === "extend" || tool === "split") {
      const hit = this.hitAt(e);
      if (hit?.kind !== "curve") {
        this.state.setSketchMessage(tool === "extend" ? "Click near the end of a line or arc you want to lengthen." : "Click a line, arc, spline or part of an ellipse where you want to split it.", "info");
        return;
      }
      this.commit(tool === "extend" ? extendAt(d, hit.id, { x: e.x, y: e.y }) : splitAt(d, hit.id, { x: e.x, y: e.y }), []);
      this.emit({ hover: null });
      return;
    }
    if (tool === "trim") {
      const hit = this.hitAt(e);
      if (hit?.kind !== "curve") {
        this.state.setSketchMessage("Click the part of a line, arc, circle, spline or ellipse you want to cut away.", "info");
        return;
      }
      this.commit(trimAt(d, hit.id, { x: e.x, y: e.y }), []);
      this.emit({ hover: null });
      return;
    }
    if (tool === "offset") {
      const hit = this.hitAt(e);
      if (hit?.kind !== "curve") {
        this.state.setSketchMessage("Click a line, arc, circle, spline or ellipse — on the side you want the copy.", "info");
        return;
      }
      const r = offsetCurves(d, hit.id, { x: e.x, y: e.y }, this.state.sketch?.offsetDistance ?? "2");
      this.commit(r, r.curveIds);
      this.emit({ hover: null });
      return;
    }
    if (tool === "useEdge" || tool === "intersect") return;
    if (tool === "mirror") return this.mirrorClick(e);
    if (tool === "sketchPattern" || tool === "sketchTransform") return this.patternClick(e);
    if (tool === "sketchFillet") {
      const hit = this.hitAt(e);
      if (hit?.kind !== "point" || hit.id === ORIGIN_ID) {
        this.state.setSketchMessage("Click the corner point where two lines or arcs meet.", "info");
        return;
      }
      const r = filletCorner(d, hit.id, this.state.sketch?.filletRadius ?? "2");
      this.commit(r, r.arcId ? [r.arcId] : []);
      return;
    }

    // Drawing on: any size offered for the last shape and not typed is dropped.
    this.state.discardOfferedDimensions();
    const p = this.placeAt(e);
    const construction = this.state.sketch?.construction ?? false;

    switch (tool) {
      case "point": {
        const r = addPoint(d, p);
        this.commit(r, [r.pointId]);
        return;
      }
      case "text": {
        const settings = readTextSettings(this.state.sketch ?? {});
        if (typeof settings === "string") {
          this.state.setSketchMessage(settings, "error");
          return;
        }
        const r = addText(d, p, settings, construction);
        if (this.commit(r, [r.textId]))
          this.state.setSketchMessage("Text added. Change its words, size or turn in the sketch panel (double-click text to edit it later); dimension its point to place it exactly.", "info");
        return;
      }
      case "line": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const start = this.placed[0];
        let end = p;
        let orientation: "horizontal" | "vertical" | null = null;
        if (!p.snap) {
          const inf = inferOrientation(start.x, start.y, p.x, p.y);
          end = { x: inf.x, y: inf.y, snap: null };
          orientation = inf.orientation;
        }
        const r = addLine(d, start, end, { construction, orientation });
        if (!this.commit(r)) return;
        if (!construction) this.offerDimensions([[r.lineId]]);
        // Keep drawing from the new end, unless we just closed the shape (or ended on a corner of the face).
        const closed = p.snap?.kind === "point" || p.snap?.kind === "origin" || (p.snap?.kind === "ref" && p.snap.at !== "on" && p.snap.at !== "mid");
        this.placed = closed ? [] : [{ ...end, snap: { kind: "point", id: r.endId } }];
        this.emit({ preview: [], inference: null });
        return;
      }
      case "rectangle": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const r = addRectangle(d, this.placed[0], p, construction);
        if (this.commit(r)) {
          this.placed = [];
          if (!construction) this.offerDimensions([[r.lineIds[0]], [r.lineIds[1]]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "centreRectangle": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const r = addCentreRectangle(d, this.placed[0], p, construction);
        if (this.commit(r)) {
          this.placed = [];
          if (!construction) this.offerDimensions([[r.lineIds[0]], [r.lineIds[1]]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "tangentArc": {
        if (this.placed.length === 0) {
          const id = p.snap?.kind === "point" ? p.snap.id : null;
          if (!id || !tangentAt(d, id)) {
            this.state.setSketchMessage("Click the end of a line or arc to carry on from.", "info");
            return;
          }
          this.placed = [p];
          this.state.setSketchMessage(null);
          return;
        }
        const startId = (this.placed[0].snap as { id: string }).id;
        const r = addTangentArc(d, startId, p, construction);
        if (!this.commit(r, [r.arcId])) return;
        // Keep going from the arc's new end, like the line tool.
        const arc = r.sketch.curves.find((c) => c.id === r.arcId);
        const endId = arc?.type === "arc" ? (arc.start === startId ? arc.end : arc.start) : null;
        const closed = p.snap?.kind === "point" || p.snap?.kind === "origin";
        this.placed = endId && !closed ? [{ ...p, snap: { kind: "point", id: endId } }] : [];
        this.emit({ preview: [] });
        return;
      }
      case "spline": {
        // Each click adds a point; clicking the first point again closes it, Esc finishes an open one.
        const first = this.placed[0];
        const closing = this.placed.length >= 3 && !!first && Math.hypot(p.x - first.x, p.y - first.y) < POINT_PX * e.mmPerPx;
        if (!closing) {
          this.placed = [...this.placed, p];
          if (this.placed.length === 1) this.state.setSketchMessage("Click more points for the curve to pass through. Click the first point to close it, or Esc to finish.", "info");
          return;
        }
        const r = addSpline(d, this.placed, true, construction);
        if (this.commit(r, [r.splineId])) this.placed = [];
        this.emit({ preview: [] });
        return;
      }
      case "conic": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          this.state.setSketchMessage(this.placed.length === 1 ? "Click where the curve ends." : "Now click the corner the curve bends towards (set how full it is in the sketch panel).", "info");
          return;
        }
        const [start, end] = this.placed;
        const r = addConic(d, start, end, p, this.state.sketch?.conicRho ?? 0.5, construction);
        if (this.commit(r, [r.conicId])) {
          this.placed = [];
          this.state.setSketchMessage(null);
        }
        this.emit({ preview: [] });
        return;
      }
      case "ellipse": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          if (this.placed.length === 2) this.state.setSketchMessage("Now click to set how wide it is.", "info");
          return;
        }
        const [centre, major] = this.placed;
        const r = addEllipse(d, centre, major, [p.x, p.y], construction);
        if (this.commit(r, [r.ellipseId])) {
          this.placed = [];
          this.state.setSketchMessage(null);
          const el = r.sketch.curves.find((c) => c.id === r.ellipseId);
          if (!construction && el?.type === "ellipse") this.offerDimensions([[el.center, el.major], [el.center, el.minor]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "circle": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const c = this.placed[0];
        const r = addCircle(d, c, Math.hypot(p.x - c.x, p.y - c.y), construction);
        if (this.commit(r, [r.circleId])) {
          this.placed = [];
          if (!construction) this.offerDimensions([[r.circleId]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "circle3":
      case "centreArc":
      case "alignedRectangle": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          return;
        }
        const [a, b] = this.placed;
        let ids: string[] = [];
        let offer: string[][] = [];
        let r;
        if (tool === "circle3") {
          r = addThreePointCircle(d, a, b, p, construction);
          ids = [r.circleId];
          offer = [[r.circleId]];
        } else if (tool === "centreArc") {
          r = addCentreArc(d, a, b, p, construction);
          ids = [r.arcId];
          offer = [[r.arcId]];
        } else {
          r = addAlignedRectangle(d, a, b, [p.x, p.y], construction);
          ids = r.lineIds;
          offer = [[r.lineIds[0]], [r.lineIds[1]]];
        }
        if (this.commit(r, ids)) {
          this.placed = [];
          if (!construction) this.offerDimensions(offer);
        }
        this.emit({ preview: [] });
        return;
      }
      case "slot": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          return;
        }
        const [a, b] = this.placed;
        const r = addSlot(d, a, b, slotRadius(a, b, p), construction);
        if (this.commit(r, r.curveIds)) {
          this.placed = [];
          // Offer its length (centre to centre) and the round ends' size.
          if (!construction && r.axisId) this.offerDimensions([[r.axisId], [r.curveIds[2]]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "polygon": {
        if (this.placed.length === 0) {
          this.placed = [p];
          return;
        }
        const r = addPolygon(d, this.placed[0], p, this.state.sketch?.polygonSides ?? 6, construction, this.state.sketch?.polygonAcross ?? "corners");
        if (this.commit(r, r.lineIds)) {
          this.placed = [];
          // Offer its size: across corners, or across flats.
          if (!construction && r.sizeCircleId) this.offerDimensions([[r.sizeCircleId]]);
        }
        this.emit({ preview: [] });
        return;
      }
      case "arc": {
        if (this.placed.length < 2) {
          this.placed = [...this.placed, p];
          return;
        }
        const r = addArc(d, this.placed[0], this.placed[1], { x: p.x, y: p.y }, construction);
        if (this.commit(r, [r.arcId])) {
          this.placed = [];
          if (!construction) this.offerDimensions([[r.arcId]]);
        }
        this.emit({ preview: [] });
        return;
      }
    }
  }

  pointerMove(e: SketchPointer, dragging: boolean): void {
    const d = this.data;
    if (!d) return;
    const tool = this.tool;
    if (tool === "select") {
      if (dragging && this.drag) return this.selectDrag(e);
      const hover = this.pickAt(e) ?? this.extraAt(e);
      this.emit({ hover, preview: [], snap: null, inference: null, hints: this.hintsFor(hover) });
      return;
    }
    if (tool === "useEdge" || tool === "intersect") return;
    if (tool === "sketchPattern" || tool === "sketchTransform") {
      const circular = tool === "sketchPattern" && this.state.sketch?.patternKind === "circular";
      const picking = tool === "sketchPattern" && this.state.sketch?.patternKind === "linear" && this.state.sketch.patternDirectionPick;
      const over = circular || picking ? this.pickAt(e) : null;
      const hit = over?.kind === "point" || picking ? over : this.hitAt(e);
      this.emit({ hover: hit?.kind === "curve" || (circular && hit?.kind === "point") ? hit : null, snap: null, preview: this.patternPreview(), hints: [] });
      return;
    }
    if (tool === "dimension") {
      const hover = this.pickAt(e);
      if (this.transient.pending.length) this.emit({ hover, snap: null, hints: [], ...this.dimensionPreview(e) });
      else this.emit({ hover, snap: null, preview: [], hints: this.hintsFor(hover) });
      return;
    }
    if (tool === "trim" || tool === "extend" || tool === "split" || tool === "sketchFillet" || tool === "offset" || tool === "mirror") {
      const hit = this.hitAt(e);
      this.emit({ hover: (tool === "trim" || tool === "extend" || tool === "split" || tool === "offset" || tool === "mirror") && hit?.kind !== "curve" ? null : hit, snap: null, preview: [], hints: [] });
      return;
    }

    // Passing over a point picks it up, to line up with afterwards; passing over a circle's rim picks up its centre.
    const over = this.hitAt(e);
    const overCurve = over?.kind === "curve" ? curveById(d, over.id) : undefined;
    const pickedUp = over?.kind === "point" ? over.id : overCurve && (overCurve.type === "circle" || overCurve.type === "arc" || overCurve.type === "ellipse") ? overCurve.center : null;
    if (pickedUp && this.acquired[0] !== pickedUp) this.acquired = [pickedUp, ...this.acquired.filter((x) => x !== pickedUp)].slice(0, 4);
    const snapped = this.snapAt(e);
    const p = snapped.placed;
    const preview: PreviewShape[] = [];
    if (p.snap?.kind === "align") {
      for (const id of [p.snap.x, p.snap.y]) if (id) preview.push({ kind: "guide", a: pointPos(d, id), b: [p.x, p.y] });
    }
    let inference: SketchTransient["inference"] = null;
    let snap = this.snapMarker(p);
    const first = this.placed[0];
    if (tool === "line" && first) {
      let end: [number, number] = [p.x, p.y];
      if (!p.snap) {
        const inf = inferOrientation(first.x, first.y, p.x, p.y);
        end = [inf.x, inf.y];
        if (inf.orientation) {
          inference = { at: end, text: inf.orientation === "horizontal" ? "H" : "V" };
          snap = end;
        }
      }
      preview.push({ kind: "line", a: [first.x, first.y], b: end });
    } else if (tool === "spline" && first) {
      const pts = splinePolyline([...this.placed.map((q): [number, number] => [q.x, q.y]), [p.x, p.y]], false);
      for (let i = 0; i + 1 < pts.length; i++) preview.push({ kind: "line", a: pts[i], b: pts[i + 1] });
    } else if (tool === "rectangle" && first) {
      const a: [number, number] = [first.x, first.y];
      const c: [number, number] = [p.x, p.y];
      const b: [number, number] = [c[0], a[1]];
      const dd: [number, number] = [a[0], c[1]];
      preview.push({ kind: "line", a, b }, { kind: "line", a: b, b: c }, { kind: "line", a: c, b: dd }, { kind: "line", a: dd, b: a });
    } else if (tool === "centreRectangle" && first) {
      const c: [number, number] = [p.x, p.y];
      const a: [number, number] = [2 * first.x - p.x, 2 * first.y - p.y];
      const b: [number, number] = [c[0], a[1]];
      const dd: [number, number] = [a[0], c[1]];
      preview.push({ kind: "line", a, b }, { kind: "line", a: b, b: c }, { kind: "line", a: c, b: dd }, { kind: "line", a: dd, b: a }, { kind: "guide", a, b: c });
    } else if (tool === "tangentArc" && first) {
      const startId = (first.snap as { id: string }).id;
      const t = tangentAt(d, startId);
      const centre = t ? tangentArcCentre([first.x, first.y], t.dir, [p.x, p.y]) : null;
      if (t && centre) {
        const r = Math.hypot(first.x - centre[0], first.y - centre[1]);
        const left = t.dir[0] * (p.y - first.y) - t.dir[1] * (p.x - first.x) > 0;
        const [from, to] = left ? [[first.x, first.y], [p.x, p.y]] : [[p.x, p.y], [first.x, first.y]];
        preview.push({ kind: "arc", c: centre, r, a0: Math.atan2(from[1] - centre[1], from[0] - centre[0]), a1: Math.atan2(to[1] - centre[1], to[0] - centre[0]) });
      } else preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
    } else if (tool === "circle3" && first) {
      const second = this.placed[1];
      if (!second) preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      else {
        const c = circleThrough([first.x, first.y], [second.x, second.y], [p.x, p.y]);
        if (c) preview.push({ kind: "circle", c, r: Math.hypot(first.x - c[0], first.y - c[1]) });
        else preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      }
    } else if (tool === "centreArc" && first) {
      const second = this.placed[1];
      if (!second) {
        const r = Math.hypot(p.x - first.x, p.y - first.y);
        preview.push({ kind: "guide", a: [first.x, first.y], b: [p.x, p.y] }, { kind: "circle", c: [first.x, first.y], r });
      } else {
        const r = Math.hypot(second.x - first.x, second.y - first.y);
        const a0 = Math.atan2(second.y - first.y, second.x - first.x);
        let sweep = Math.atan2(p.y - first.y, p.x - first.x) - a0;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep <= -Math.PI) sweep += 2 * Math.PI;
        const [s0, s1] = sweep >= 0 ? [a0, a0 + sweep] : [a0 + sweep, a0];
        preview.push({ kind: "arc", c: [first.x, first.y], r, a0: s0, a1: s1 }, { kind: "guide", a: [first.x, first.y], b: [second.x, second.y] });
      }
    } else if (tool === "alignedRectangle" && first) {
      const second = this.placed[1];
      if (!second) preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      else {
        const A: [number, number] = [first.x, first.y];
        const B: [number, number] = [second.x, second.y];
        const l = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        const w = alignedWidth(A, B, [p.x, p.y]);
        const n: [number, number] = [(-(B[1] - A[1]) / l) * w, ((B[0] - A[0]) / l) * w];
        const C: [number, number] = [B[0] + n[0], B[1] + n[1]];
        const D: [number, number] = [A[0] + n[0], A[1] + n[1]];
        preview.push({ kind: "line", a: A, b: B }, { kind: "line", a: B, b: C }, { kind: "line", a: C, b: D }, { kind: "line", a: D, b: A });
      }
    } else if (tool === "slot" && first) {
      if (this.placed.length === 1) preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      else preview.push(...slotPreview(first, this.placed[1], slotRadius(first, this.placed[1], p)));
    } else if (tool === "polygon" && first) {
      const n = Math.max(3, Math.min(64, Math.round(this.state.sketch?.polygonSides ?? 6)));
      const across = this.state.sketch?.polygonAcross ?? "corners";
      const corners = polygonCorners([first.x, first.y], [p.x, p.y], n, across);
      for (let i = 0; i < n; i++) preview.push({ kind: "line", a: corners[i], b: corners[(i + 1) % n] });
      const r = Math.hypot(p.x - first.x, p.y - first.y);
      if (r > 1e-9) preview.push({ kind: "guide", a: [first.x, first.y], b: [p.x, p.y] });
    } else if (tool === "conic" && first) {
      const second = this.placed[1];
      if (!second) preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      else {
        const a: [number, number] = [first.x, first.y];
        const b: [number, number] = [second.x, second.y];
        const m: [number, number] = [p.x, p.y];
        const pts = splinePolyline([a, m, b], false, 16, this.state.sketch?.conicRho ?? 0.5);
        for (let i = 0; i + 1 < pts.length; i++) preview.push({ kind: "line", a: pts[i], b: pts[i + 1] });
        preview.push({ kind: "guide", a, b: m }, { kind: "guide", a: m, b });
      }
    } else if (tool === "ellipse" && first) {
      const c: [number, number] = [first.x, first.y];
      const second = this.placed[1];
      if (!second) {
        const r = Math.hypot(p.x - first.x, p.y - first.y);
        preview.push({ kind: "line", a: c, b: [p.x, p.y] }, { kind: "circle", c, r });
      } else {
        const m: [number, number] = [second.x, second.y];
        const pts = ellipsePolyline(ellipseFrom(c, m, minorPointFor(c, m, [p.x, p.y])));
        for (let i = 0; i + 1 < pts.length; i++) preview.push({ kind: "line", a: pts[i], b: pts[i + 1] });
        preview.push({ kind: "guide", a: c, b: m });
      }
    } else if (tool === "circle" && first) {
      preview.push({ kind: "circle", c: [first.x, first.y], r: Math.hypot(p.x - first.x, p.y - first.y) });
    } else if (tool === "arc" && first) {
      if (this.placed.length === 1) {
        preview.push({ kind: "line", a: [first.x, first.y], b: [p.x, p.y] });
      } else {
        const second = this.placed[1];
        const centre = circleThrough([first.x, first.y], [p.x, p.y], [second.x, second.y]);
        if (centre) {
          const r = Math.hypot(first.x - centre[0], first.y - centre[1]);
          const cross = (second.x - first.x) * (p.y - first.y) - (second.y - first.y) * (p.x - first.x);
          const [from, to] = cross < 0 ? [first, second] : [second, first];
          preview.push({
            kind: "arc",
            c: centre,
            r,
            a0: Math.atan2(from.y - centre[1], from.x - centre[0]),
            a1: Math.atan2(to.y - centre[1], to.x - centre[0]),
          });
        } else preview.push({ kind: "line", a: [first.x, first.y], b: [second.x, second.y] });
      }
    }
    this.emit({ hover: snapped.hover?.kind === "curve" ? snapped.hover : null, preview, snap, inference, hints: snapped.hints });
  }

  pointerUp(): void {
    if (this.tool !== "select" || !this.drag) return;
    const drag = this.drag;
    this.drag = null;
    if (drag.moved && drag.kind === "none") {
      this.emit({ preview: [] });
      const d = this.data;
      if (!d || !drag.box) return;
      const found = sketchItemsInBox(d, rectOf(drag.startX, drag.startY, drag.box.x, drag.box.y), drag.box.crossing);
      const sel = this.state.sketch?.selection ?? [];
      this.state.setSketchSelection(drag.additive ? [...new Set([...sel, ...found])] : found);
      return;
    }
    if (drag.moved) {
      if (drag.kind === "point" && drag.snapTo) {
        const r = attachPoint(this.data ?? drag.start, drag.id, drag.snapTo);
        if (r.error) this.state.setSketchMessage(r.error, "error");
        else this.state.updateSketch(r.sketch, { record: false });
        this.emit({ snap: null, hints: [] });
      }
      this.state.recordSketchStep(drag.start);
      return;
    }
    // A click without dragging: select (a click on a handle leaves the selection as it is).
    if (drag.kind === "handle") return;
    const sel = this.state.sketch?.selection ?? [];
    if (!drag.hit) {
      if (!drag.additive) this.state.setSketchSelection([]);
      return;
    }
    // A part edge of the face: bring it in (as a reference) and select that.
    const id = this.realId(drag.hit.id);
    if (!id) return;
    if (drag.additive) this.state.setSketchSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    else this.state.setSketchSelection(sel.length === 1 && sel[0] === id ? [] : [id]);
  }

  pointerLeave(): void {
    this.emit({ hover: null, snap: null, inference: null, hints: [] });
  }

  /** Esc: abandon a half-drawn shape. Returns true if there was one. */
  cancel(): boolean {
    // Esc finishes a spline that has enough points (rather than throwing it away).
    if (this.tool === "spline" && this.placed.length >= 2 && this.data) {
      const r = addSpline(this.data, this.placed, false, this.state.sketch?.construction ?? false);
      this.placed = [];
      this.emit({ preview: [] });
      this.commit(r, r.splineId ? [r.splineId] : []);
      return true;
    }
    const had = this.placed.length > 0 || this.transient.pending.length > 0 || this.drag !== null;
    if (this.drag?.moved) this.state.updateSketch(this.drag.start, { record: false });
    this.placed = [];
    this.drag = null;
    this.emit({ preview: [], inference: null, pending: [], snap: null, hints: [] });
    return had;
  }

  // ---------------------------------------------------------------------------
  // Select tool: click to select, drag to move

  private selectDown(e: SketchPointer) {
    const d = this.data!;
    // A spline handle (shown on selected splines) takes priority over whatever is under it.
    const handle = this.handleAt(e);
    if (handle) {
      this.drag = { kind: "handle", id: handle.splineId, start: d, startX: e.x, startY: e.y, moved: false, additive: false, hit: null, handle };
      return;
    }
    const hit = this.pickAt(e);
    let kind: DragState["kind"] = "none";
    // Text (dragged by its point) or a picture under the pointer, when there's nothing else there.
    const extra = hit ? null : this.extraAt(e);
    if (extra) {
      const text = textById(d, extra.id);
      const now = Date.now();
      // A double-click on text: select it and put the cursor in the sketch panel's text box.
      if (text && this.lastTextClick?.id === text.id && now - this.lastTextClick.at < 450) {
        this.lastTextClick = null;
        this.state.setSketchSelection([text.id]);
        this.state.setSketchOptions({ textFocus: now });
        this.drag = null;
        return;
      }
      this.lastTextClick = text ? { id: text.id, at: now } : null;
      if (text) this.drag = { kind: text.anchor === ORIGIN_ID ? "none" : "point", id: text.anchor, start: d, startX: e.x, startY: e.y, moved: false, additive: e.shift || e.ctrl, hit: extra, startScreenX: e.screenX };
      else this.drag = { kind: "image", id: extra.id, start: d, startX: e.x, startY: e.y, moved: false, additive: e.shift || e.ctrl, hit: extra, startScreenX: e.screenX };
      return;
    }
    if (hit && isRefId(hit.id)) {
      // Part edges can't be dragged: a click selects (brings in) one, a drag draws a selection box.
    } else if (hit?.kind === "point" && hit.id !== ORIGIN_ID) kind = "point";
    else if (hit?.kind === "curve") {
      const c = curveById(d, hit.id)!;
      // Dragging a circle's or an arc's rim resizes it; drag its centre point to move it.
      kind = c.type === "circle" || c.type === "arc" ? "rim" : "curve";
    }
    this.drag = { kind, id: hit?.id ?? "", start: d, startX: e.x, startY: e.y, moved: false, additive: e.shift || e.ctrl, hit, startScreenX: e.screenX };
  }

  /** When text was last clicked (for telling a double-click). */
  private lastTextClick: { id: string; at: number } | null = null;

  /** Text or a picture under the pointer (text first; a picture only where nothing else is). */
  private extraAt(e: SketchPointer): Hit | null {
    const d = this.data;
    if (!d) return null;
    const t = textAt(d, e.x, e.y, CURVE_PX * e.mmPerPx);
    if (t) return { kind: "curve", id: t };
    const m = imageAt(d, e.x, e.y);
    return m ? { kind: "curve", id: m } : null;
  }

  private selectDrag(e: SketchPointer) {
    const drag = this.drag!;
    if (!drag.moved && Math.hypot(e.x - drag.startX, e.y - drag.startY) < DRAG_PX * e.mmPerPx) return;
    drag.moved = true;
    if (drag.kind === "none") {
      // From empty space: a selection box. Leftwards takes anything it touches.
      const crossing = e.screenX !== undefined && drag.startScreenX !== undefined ? e.screenX < drag.startScreenX : e.x < drag.startX;
      drag.box = { x: e.x, y: e.y, crossing };
      const a: [number, number] = [drag.startX, drag.startY];
      const b: [number, number] = [e.x, drag.startY];
      const c: [number, number] = [e.x, e.y];
      const dd: [number, number] = [drag.startX, e.y];
      const kind = crossing ? "guide" : "line";
      this.emit({ preview: [{ kind, a, b }, { kind, a: b, b: c }, { kind, a: c, b: dd }, { kind, a: dd, b: a }], hover: null });
      return;
    }
    let next = drag.start;
    if (drag.kind === "handle" && drag.handle) {
      // The handle end follows the pointer: the curve's direction and speed at that point (its tangent is three times the handle).
      const h = drag.handle;
      const [px, py] = pointPos(drag.start, h.pointId);
      const dx = e.x - px;
      const dy = e.y - py;
      // Dropped back onto the point: the handle is cleared and the curve runs naturally again.
      const reset = Math.hypot(dx, dy) < POINT_PX * e.mmPerPx;
      next = setSplineHandle(drag.start, h.splineId, h.pointId, reset ? null : [3 * dx * h.side, 3 * dy * h.side]);
      this.state.updateSketch(next, { record: false });
      return;
    }
    if (drag.kind === "point") {
      // Hovering close to another point snaps onto it (and joins them when let go).
      // A wider reach than a click, so an end point dropped near another joins onto it.
      // Also onto the middle of a line, or a corner, centre or middle of the face's edges.
      const found = this.data ? snapAt(drag.start, e.x, e.y, { pointTol: SNAP_PX * e.mmPerPx, curveTol: 0, refs: this.refs, ignore: pointsSharingCurve(drag.start, drag.id) }) : null;
      const sn = found?.placed.snap;
      drag.snapTo = sn && (sn.kind === "point" || sn.kind === "origin" || sn.kind === "midpoint" || (sn.kind === "ref" && sn.at !== "on")) ? sn : null;
      const [x, y] = drag.snapTo ? [found!.placed.x, found!.placed.y] : [e.x, e.y];
      next = dragPoint(drag.start, drag.id, x, y);
      this.emit({ snap: drag.snapTo ? [x, y] : null, hints: drag.snapTo?.kind === "midpoint" ? [[x, y]] : [] });
    }
    else if (drag.kind === "curve") next = dragCurve(drag.start, drag.id, e.x - drag.startX, e.y - drag.startY);
    else if (drag.kind === "image") {
      const m = imageById(drag.start, drag.id);
      if (m) next = { ...drag.start, images: (drag.start.images ?? []).map((x) => (x.id === m.id ? { ...m, x: m.x + e.x - drag.startX, y: m.y + e.y - drag.startY } : x)) };
    }
    else {
      const c = curveById(drag.start, drag.id);
      if (c?.type === "circle") {
        const [cx, cy] = pointPos(drag.start, c.center);
        next = dragCircleRim(drag.start, c.id, Math.hypot(e.x - cx, e.y - cy));
      } else if (c?.type === "arc") {
        const [cx, cy] = pointPos(drag.start, c.center);
        next = dragArcRim(drag.start, c.id, Math.hypot(e.x - cx, e.y - cy));
      }
    }
    this.state.updateSketch(next, { record: false });
  }

  // ---------------------------------------------------------------------------
  // Dimension tool: pick one or two things, then click where the value goes

  /** While placing a dimension: where it would go, and whether it measures across, up or straight. */
  private dimensionPreview(e: SketchPointer): Pick<SketchTransient, "preview" | "inference"> {
    const d = this.data!;
    const base = dimensionFor(d, this.transient.pending);
    if (typeof base === "string") return { preview: [], inference: null };
    const offset = offsetFor(d, { id: "tmp", ...base }, [e.x, e.y]);
    const spec = dimensionSpecAt(d, this.transient.pending, offset);
    if (typeof spec === "string") return { preview: [], inference: null };
    const layout = dimensionLayout(d, { id: "tmp", ...spec, value: "0", labelOffset: offset });
    const preview: PreviewShape[] = (layout?.lines ?? []).map(([a, b]) => ({ kind: "guide", a, b }));
    const text = spec.type === "horizontalDistance" ? "Across" : spec.type === "verticalDistance" ? "Up" : null;
    // Say which kind it will be when that changes as the pointer moves.
    if (spec.type !== this.previewKind) {
      this.previewKind = spec.type;
      const what =
        spec.type === "horizontalDistance" ? "the distance across" : spec.type === "verticalDistance" ? "the distance up" : spec.type === "length" ? "the line's length" : spec.type === "distance" ? "the straight distance" : null;
      if (what) this.state.setSketchMessage(`Click to place ${what} — moving the value round picks across, up or straight.`, "info");
    }
    return { preview, inference: text ? { at: [e.x, e.y], text } : null };
  }

  private dimensionClick(e: SketchPointer) {
    this.previewKind = null;
    const picked = this.pickAt(e);
    const pending = this.transient.pending;
    // A part edge (or its corner) of the face: bring it in as a reference to measure from.
    const wanted = picked && pending.length < 2 ? this.realId(picked.id) : null;
    const hit = picked && wanted ? { ...picked, id: wanted } : picked && !isRefId(picked.id) ? picked : null;
    const d = this.data!;
    if (hit && pending.length < 2 && !pending.includes(hit.id)) {
      const next = [...pending, hit.id];
      // Only keep a second pick if it makes a valid pair; otherwise start again with it.
      const ok = next.length === 1 || typeof dimensionFor(d, next) !== "string";
      this.emit({ pending: ok ? next : [hit.id] });
      // A lone arc: say how to get its angle or length instead of its radius.
      const only = (ok ? next : [hit.id]).length === 1 ? curveById(d, hit.id) : undefined;
      this.state.setSketchMessage(
        only?.type === "arc"
          ? "Now click where the radius goes — or click the arc's centre for its angle, or one of its ends for its length."
          : "Now click where the dimension should go.",
        "info",
      );
      return;
    }
    if (pending.length === 0) {
      this.state.setSketchMessage("Click a line, circle or arc — or two things to measure between. Where you put the value picks across, up or straight.", "info");
      return;
    }
    const spec = dimensionFor(d, pending);
    if (typeof spec === "string") {
      this.state.setSketchMessage(spec, "error");
      this.emit({ pending: [] });
      return;
    }
    const offset = offsetFor(d, { id: "tmp", ...spec }, [e.x, e.y]);
    const r = addDimension(d, pending, offset);
    this.emit({ pending: [] });
    if (!this.commit(r)) return;
    if (r.driven) {
      this.state.setSketchMessage("That's already set by other constraints or dimensions, so this one just shows the size (in brackets) and won't change the sketch.", "info");
      return;
    }
    this.state.setEditingDimension(r.dimensionId);
  }
}

/** Half the slot's width: how far the third click is from the line through the two centres. */
function slotRadius(a: { x: number; y: number }, b: { x: number; y: number }, p: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / (Math.hypot(dx, dy) || 1);
}

function slotPreview(a: { x: number; y: number }, b: { x: number; y: number }, r: number): PreviewShape[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * r, ny = (dx / L) * r;
  const ang = Math.atan2(ny, nx);
  return [
    { kind: "line", a: [a.x + nx, a.y + ny], b: [b.x + nx, b.y + ny] },
    { kind: "line", a: [a.x - nx, a.y - ny], b: [b.x - nx, b.y - ny] },
    { kind: "arc", c: [a.x, a.y], r, a0: ang, a1: ang + Math.PI },
    { kind: "arc", c: [b.x, b.y], r, a0: ang + Math.PI, a1: ang },
  ];
}
