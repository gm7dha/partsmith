import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { evaluate } from "../model/expr";
import { lengthNumber, showLength, storeLength, type LengthUnit } from "../model/units";
import { useLengthUnit, useStore } from "../model/store";
import { badgeAnchors, dimensionLayout, RELATION_SYMBOLS } from "../sketch/layout";
import { measure, moveDimensionLabel, setDimensionValue } from "../sketch/ops";
import { linkedPoints } from "../sketch/links";
import { isAngleDimension, isDimension, type SketchConstraint, type SketchData } from "../sketch/types";
import { sketchStatus, viewportApi } from "../viewport/Viewport";

const RELATION_NAMES: Partial<Record<SketchConstraint["type"], string>> = {
  coincident: "Coincident",
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  equal: "Equal",
  tangent: "Tangent",
  concentric: "Concentric",
  midpoint: "Midpoint",
  pointOnLine: "Point on line",
  pointOnCircle: "Point on circle",
  pointOnCurve: "Point on curve",
  fix: "Fixed",
  patternCopy: "Pattern copy",
  patternMove: "Pattern copy",
  normal: "Normal",
  curvature: "Curvature",
};

/** Text shown on a dimension label. A reference (driven) dimension shows the size as it is now, in brackets. */
function dimensionText(c: SketchConstraint, unit: LengthUnit, data?: SketchData): string {
  let value: number | null = null;
  if (c.driven && data) {
    try {
      value = measure(data, c);
    } catch {
      value = null;
    }
  } else {
    const r = evaluate(c.value ?? "");
    if (r.ok) value = r.value;
  }
  const shown = value === null ? c.value ?? "?" : isAngleDimension(c) ? String(Math.round(value * 100) / 100) : lengthNumber(value, unit);
  // An arc's length gets the arc sign (⌒) in front, like a drawing.
  const text = c.type === "diameter" ? `⌀${shown}` : c.type === "radius" ? `R${shown}` : isAngleDimension(c) ? `${shown}°` : c.type === "arcLength" ? `⌒${shown}` : shown;
  return c.driven ? `(${text})` : text;
}

/** Shared empty list: a selector must not return a new array each time, or React re-renders forever. */
const NO_SELECTION: string[] = [];

interface Placement {
  id: string;
  /** Sketch position the element sits at. */
  at: [number, number];
  /** Extra screen-pixel nudge (to spread badges sharing a spot). */
  dx: number;
  dy: number;
}

/**
 * Dimension values and constraint badges drawn over the 3D view while a
 * sketch is open. Their positions follow the camera every frame.
 */
export function SketchOverlay() {
  const data = useStore((s) => (s.editing?.draft.type === "sketch" && s.editing.draft.sketch?.plane ? s.editing.draft.sketch.data : null));
  const selection = useStore((s) => s.sketch?.selection ?? NO_SELECTION);
  const editingDimension = useStore((s) => s.sketch?.editingDimension ?? null);
  const elements = useRef(new Map<string, HTMLElement>());
  const placements = useRef<Placement[]>([]);

  const layout = useMemo(() => (data ? computePlacements(data) : { dims: [], badges: [] }), [data]);
  placements.current = [...layout.dims.map((d) => d.placement), ...layout.badges.map((b) => b.placement)];

  // Reposition every frame (camera may be moving).
  useEffect(() => {
    let off: (() => void) | undefined;
    let raf = 0;
    const attach = () => {
      const manager = viewportApi.current;
      if (!manager) {
        raf = requestAnimationFrame(attach);
        return;
      }
      off = manager.addFrameListener(() => {
        for (const p of placements.current) {
          const el = elements.current.get(p.id);
          if (!el) continue;
          const s = manager.projectSketchPoint(p.at[0], p.at[1]);
          if (!s) continue;
          el.style.transform = `translate(${Math.round(s.x + p.dx)}px, ${Math.round(s.y + p.dy)}px) translate(-50%, -50%)`;
        }
      });
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      off?.();
    };
  }, []);

  if (!data) return null;
  const failing = sketchStatus(data).failing;
  const ref = (id: string) => (el: HTMLElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  };

  return (
    <div className="sketch-overlay" aria-label="Sketch dimensions and constraints">
      {layout.dims.map(({ constraint: c, placement }) => (
        <DimensionLabel
          key={c.id}
          c={c}
          refCb={ref(placement.id)}
          selected={selection.includes(c.id)}
          failing={failing.has(c.id)}
          editing={editingDimension === c.id}
        />
      ))}
      {layout.badges.map(({ constraint: c, placement }) => (
        <button
          key={placement.id}
          ref={ref(placement.id)}
          className={`constraint-badge${selection.includes(c.id) ? " selected" : ""}${failing.has(c.id) ? " failing" : ""}`}
          title={`${RELATION_NAMES[c.type] ?? c.type} — click to select, then Delete to remove`}
          aria-label={RELATION_NAMES[c.type] ?? c.type}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => toggleSelect(c.id, e.shiftKey || e.ctrlKey || e.metaKey)}
        >
          {RELATION_SYMBOLS[c.type]}
        </button>
      ))}
    </div>
  );
}

function toggleSelect(id: string, additive: boolean) {
  const s = useStore.getState();
  const sel = s.sketch?.selection ?? [];
  if (additive) s.setSketchSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  else s.setSketchSelection(sel.length === 1 && sel[0] === id ? [] : [id]);
}

function computePlacements(data: SketchData) {
  const dims: { constraint: SketchConstraint; placement: Placement }[] = [];
  const badges: { constraint: SketchConstraint; placement: Placement }[] = [];
  const spots = new Map<string, number>();
  // Part edges in the sketch are held where their edge is: that's not shown as anchors on each of their points.
  const linked = linkedPoints(data);
  for (const c of data.constraints) {
    if (isDimension(c)) {
      const l = dimensionLayout(data, c);
      if (l) dims.push({ constraint: c, placement: { id: c.id, at: l.label, dx: 0, dy: 0 } });
      continue;
    }
    if (c.type === "coincident" || c.type === "pointOnLine" || c.type === "pointOnCircle" || c.type === "pointOnCurve") continue; // too cluttered; shown as joined points
    if (c.type === "patternCopy" || c.type === "patternMove" || (c.type === "fix" && linked.has(c.refs[0]))) continue;
    badgeAnchors(data, c).forEach((at, i) => {
      const key = `${Math.round(at[0] * 100)},${Math.round(at[1] * 100)}`;
      const n = spots.get(key) ?? 0;
      spots.set(key, n + 1);
      badges.push({ constraint: c, placement: { id: `${c.id}:${i}`, at, dx: 14 + n * 18, dy: -14 } });
    });
  }
  return { dims, badges };
}

function DimensionLabel({
  c,
  refCb,
  selected,
  failing,
  editing,
}: {
  c: SketchConstraint;
  refCb: (el: HTMLElement | null) => void;
  selected: boolean;
  failing: boolean;
  editing: boolean;
}) {
  const unit = useLengthUnit();
  // A reference dimension shows the size the sketch has now.
  const data = useStore((s) => (c.driven ? s.editing?.draft.sketch?.data ?? null : null));
  // Lengths are shown and typed in the design's units (see units.ts); angles in degrees.
  const shownValue = isAngleDimension(c) ? c.value ?? "" : showLength(c.value ?? "", unit);
  const [text, setText] = useState(shownValue);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ startData: SketchData; moved: boolean; x: number; y: number } | null>(null);
  useEffect(() => {
    if (editing) {
      setText(shownValue);
      setError(null);
    }
  }, [editing, shownValue]);

  // A size offered just after drawing (Enter keeps it, Esc drops it).
  const offered = () => useStore.getState().sketch?.provisional.includes(c.id) ?? false;
  const done = () => {
    const s = useStore.getState();
    if (offered()) s.keepOfferedDimension(c.id);
    else s.setEditingDimension(null);
  };
  const apply = () => {
    const s = useStore.getState();
    const current = s.editing?.draft.sketch?.data;
    if (!current) return;
    if (text.trim() === shownValue.trim()) {
      done();
      return;
    }
    const r = setDimensionValue(current, c.id, isAngleDimension(c) ? text.trim() : storeLength(text.trim(), unit));
    if (r.error) {
      setError(r.error);
      return;
    }
    s.updateSketch(r.sketch, { record: true });
    done();
  };

  if (editing && !c.driven) {
    return (
      <div ref={refCb} className="dimension-editor">
        <input
          autoFocus
          value={text}
          aria-label="Dimension value"
          aria-invalid={!!error}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") apply();
            if (e.key === "Escape") {
              if (offered()) useStore.getState().discardOfferedDimensions();
              else useStore.getState().setEditingDimension(null);
            }
          }}
          onBlur={() => {
            // Leaving an offered size without typing anything drops it.
            if (offered() && text.trim() === shownValue.trim()) useStore.getState().discardOfferedDimensions();
            else if (!error) apply();
          }}
        />
        <span className="unit">{isAngleDimension(c) ? "°" : unit}</span>
        {error && <div className="dimension-error">{error}</div>}
      </div>
    );
  }

  // Click: select. Double-click: edit. Drag: move the label.
  const onPointerDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    const s = useStore.getState();
    const start = s.editing?.draft.sketch?.data;
    if (!start) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startData: start, moved: false, x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    const manager = viewportApi.current;
    if (!d || !manager) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) return;
    d.moved = true;
    const host = document.querySelector(".viewport")?.getBoundingClientRect();
    if (!host) return;
    const p = manager.unprojectToSketch(e.clientX - host.left, e.clientY - host.top);
    const layout = dimensionLayout(d.startData, { ...c, labelOffset: { x: 0, y: 0 } });
    if (!p || !layout) return;
    const next = moveDimensionLabel(d.startData, c.id, { x: p.x - layout.anchor[0], y: p.y - layout.anchor[1] });
    useStore.getState().updateSketch(next, { record: false });
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) useStore.getState().recordSketchStep(d.startData);
    else toggleSelect(c.id, e.shiftKey || e.ctrlKey || e.metaKey);
  };

  return (
    <div
      ref={refCb}
      className={`dimension-label${selected ? " selected" : ""}${failing ? " failing" : ""}${c.driven ? " driven" : ""}`}
      title={c.driven ? "Just shows the size (it doesn't set it). Drag to move; select it and click \"Let it set the size\" in the sketch panel to change that" : "Double-click to change, drag to move"}
      role="button"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (c.driven) {
          useStore.getState().setSketchMessage("That dimension (in brackets) just shows the size. Select it and click \"Let it set the size\" in the sketch panel to type a new size.", "info");
          return;
        }
        useStore.getState().setEditingDimension(c.id);
      }}
    >
      {dimensionText(c, unit, data ?? undefined)}
    </div>
  );
}
