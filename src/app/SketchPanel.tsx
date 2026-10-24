import { useEffect, useMemo, useState } from "react";

import { useLengthUnit, useStore } from "../model/store";
import { showLength, storeLength } from "../model/units";
import { planeLabel } from "../sketch/planes";
import { findRegions } from "../sketch/regions";
import { measureToOf } from "../sketch/ops";
import { sketchStatus } from "../viewport/Viewport";
import { Icons } from "./icons";
import { makeSketchPattern, makeSketchTransform, setPatternOption, setSketchMeasureTo, toggleSketchDimensionDriven, copyFaceEdges } from "./sketchActions";
import { lostLinksMessage } from "../sketch/links";
import { isDimension } from "../sketch/types";
import { setConicRho } from "../sketch/tools";
import { SketchExtrasPanel } from "./SketchExtrasPanel";

/** A conic's fullness: a slider from flat to full, and the number (0.5 = a parabola). */
function ConicFullness({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const take = (raw: string) => {
    const v = Number(raw);
    if (v > 0 && v < 1) onChange(Math.round(v * 1000) / 1000);
  };
  return (
    <label className="tool-option" title="How full the conic is: less than 0.5 is flatter (part of an ellipse), 0.5 is a parabola, more is fuller (towards the corner)">
      Fullness
      <input type="range" min={0.05} max={0.95} step={0.01} value={value} aria-label="Conic fullness slider" onChange={(e) => take(e.target.value)} />
      <input
        className="short-input"
        value={text}
        spellCheck={false}
        aria-label="Conic fullness"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => take(text)}
        onKeyDown={(e) => e.key === "Enter" && take(text)}
      />
    </label>
  );
}

/** The sketch's feature panel (top-left of the viewport), like Onshape's sketch dialog. */
export function SketchPanel() {
  const draft = useStore((s) => (s.editing?.draft.type === "sketch" ? s.editing.draft : null));
  const message = useStore((s) => s.sketch?.message ?? null);
  const selectionCount = useStore((s) => s.sketch?.selection.length ?? 0);
  const tool = useStore((s) => s.sketch?.tool ?? "select");
  const polygonSides = useStore((s) => s.sketch?.polygonSides ?? 6);
  const polygonAcross = useStore((s) => s.sketch?.polygonAcross ?? "corners");
  const conicRho = useStore((s) => s.sketch?.conicRho ?? 0.5);
  const selection = useStore((s) => s.sketch?.selection);
  const filletRadius = useStore((s) => s.sketch?.filletRadius ?? "2");
  const offsetDistance = useStore((s) => s.sketch?.offsetDistance ?? "2");
  const patternKind = useStore((s) => s.sketch?.patternKind ?? "linear");
  const patternCount = useStore((s) => s.sketch?.patternCount ?? 3);
  const patternSpacing = useStore((s) => s.sketch?.patternSpacing ?? "10");
  const patternAngle = useStore((s) => s.sketch?.patternAngle ?? "0");
  const patternCentre = useStore((s) => s.sketch?.patternCentre ?? "origin");
  const patternDirectionPick = useStore((s) => s.sketch?.patternDirectionPick ?? false);
  const linkInfo = useStore((s) => (s.editing?.draft.type === "sketch" ? s.sketchLinks[s.editing.draft.id] : undefined));
  const moveDx = useStore((s) => s.sketch?.moveDx ?? "10");
  const moveDy = useStore((s) => s.sketch?.moveDy ?? "0");
  const moveAngle = useStore((s) => s.sketch?.moveAngle ?? "0");
  const moveCopy = useStore((s) => s.sketch?.moveCopy ?? false);
  const unit = useLengthUnit();
  const theme = useStore((s) => s.theme);
  const setSketchOptions = useStore((s) => s.setSketchOptions);
  const setDraftField = useStore((s) => s.setDraftField);
  const commitDraft = useStore((s) => s.commitDraft);
  const cancelDraft = useStore((s) => s.cancelDraft);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const data = draft?.sketch?.data ?? null;
  const plane = draft?.sketch?.plane ?? null;
  const status = useMemo(() => (data ? sketchStatus(data) : null), [data]);
  const regions = useMemo(() => (data ? findRegions(data) : null), [data]);
  useEffect(() => setConfirmCancel(false), [data]);

  if (!draft || !data) return null;
  const freedom = status?.analysis.freedom ?? 0;
  const conflicts = status?.failing.size ?? 0;
  const empty = data.curves.length === 0 && data.points.length === 0;
  const changed = useStore.getState().sketch?.past.length ?? 0;

  return (
    <div className="feature-dialog sketch-panel" role="region" aria-label="Sketch">
      <header className="feature-dialog-header">
        <span className="feature-dialog-title">Sketch</span>
        <span className="feature-dialog-actions">
          <button
            type="button"
            className="dialog-ok"
            onClick={() => commitDraft()}
            disabled={!plane}
            title={plane ? "Finish the sketch" : "Pick a plane first"}
            aria-label="Accept"
          >
            <Icons.Tick size={18} />
          </button>
          <button
            type="button"
            className="dialog-cancel"
            onClick={() => (changed > 0 && !confirmCancel ? setConfirmCancel(true) : cancelDraft())}
            title="Cancel and discard changes"
            aria-label="Cancel"
          >
            <Icons.Cross size={18} />
          </button>
        </span>
      </header>
      <div className="feature-dialog-body">
        <input className="feature-name-input" value={draft.name} aria-label="Sketch name" onChange={(e) => setDraftField({ name: e.target.value })} />
        <div className="sketch-plane-row">
          <span className="muted">On</span> <strong>{plane ? planeLabel(plane) : "— choose a plane —"}</strong>
        </div>
        {tool === "polygon" && (
          <label className="tool-option">
            Sides
            <input
              type="number"
              min={3}
              max={64}
              value={polygonSides}
              onChange={(e) => setSketchOptions({ polygonSides: Math.max(3, Math.min(64, Number(e.target.value) || 3)) })}
            />
          </label>
        )}
        {tool === "polygon" && (
          <div className="tool-option">
            Size across
            <div className="segmented two" role="group" aria-label="Polygon size across">
              {(["corners", "flats"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={polygonAcross === k ? "selected" : ""}
                  aria-pressed={polygonAcross === k}
                  title={k === "corners" ? "The pointer sets a corner: the size is measured corner to corner" : "The pointer sets the middle of a side: the size is measured across flat sides (like a nut or spanner size)"}
                  onClick={() => setSketchOptions({ polygonAcross: k })}
                >
                  {k === "corners" ? "Corners" : "Flats"}
                </button>
              ))}
            </div>
          </div>
        )}
        {(() => {
          // The conic tool's fullness, or the selected conic's.
          const picked = selection?.length === 1 ? data.curves.find((c) => c.id === selection[0] && c.type === "spline" && c.conic !== undefined) : undefined;
          const rho = picked?.type === "spline" ? picked.conic : tool === "conic" ? conicRho : undefined;
          if (rho === undefined) return null;
          return (
            <ConicFullness
              value={rho}
              onChange={(v) => {
                if (picked) useStore.getState().updateSketch(setConicRho(data, picked.id, v));
                else setSketchOptions({ conicRho: v });
              }}
            />
          );
        })()}
        {tool === "offset" && (
          <label className="tool-option">
            Distance
            <input value={showLength(offsetDistance, unit)} spellCheck={false} aria-label="Offset distance" onChange={(e) => setSketchOptions({ offsetDistance: storeLength(e.target.value, unit) })} />
            <span className="muted">{unit}</span>
          </label>
        )}
        {tool === "sketchPattern" && (
          <div className="pattern-options">
            <div className="segmented two" role="group" aria-label="Pattern type">
              {(["linear", "circular"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={patternKind === k ? "selected" : ""}
                  aria-pressed={patternKind === k}
                  onClick={() => setPatternOption({ patternKind: k, patternAngle: k === "linear" ? "0" : "360" })}
                >
                  {k === "linear" ? "In a row" : "Round a centre"}
                </button>
              ))}
            </div>
            <label className="tool-option">
              How many
              <input
                type="number"
                min={2}
                max={200}
                aria-label="How many"
                value={patternCount}
                onChange={(e) => setPatternOption({ patternCount: Math.max(2, Math.min(200, Math.round(Number(e.target.value)) || 2)) })}
              />
            </label>
            {patternKind === "linear" && (
              <label className="tool-option">
                Spacing
                <input value={showLength(patternSpacing, unit)} spellCheck={false} aria-label="Pattern spacing" onChange={(e) => setPatternOption({ patternSpacing: storeLength(e.target.value, unit) })} />
                <span className="muted">{unit}</span>
              </label>
            )}
            <label className="tool-option">
              {patternKind === "linear" ? "Direction" : "Spread over"}
              <input value={patternAngle} spellCheck={false} aria-label={patternKind === "linear" ? "Pattern direction" : "Pattern angle"} onChange={(e) => setPatternOption({ patternAngle: e.target.value })} />
              <span className="muted">°</span>
            </label>
            {patternKind === "linear" && (
              <button
                type="button"
                className={patternDirectionPick ? "text-button selected" : "text-button"}
                aria-pressed={patternDirectionPick}
                title="Then click a straight line (or an edge of the face) to go the way it runs"
                onClick={() => setSketchOptions({ patternDirectionPick: !patternDirectionPick })}
              >
                {patternDirectionPick ? "Click a line to set the direction…" : "Take the direction from a line"}
              </button>
            )}
            {patternKind === "circular" && patternCentre !== "origin" && (
              <button type="button" className="text-button" onClick={() => setPatternOption({ patternCentre: "origin" })} title="Go round the sketch's origin again">
                Go round the origin instead
              </button>
            )}
            <p className="dialog-hint">
              {patternKind === "linear"
                ? "Direction 0° goes right, 90° goes up. The count includes the original. The copies follow the originals (and the line, if you took the direction from one)."
                : `Going round ${patternCentre === "origin" ? "the origin" : "the chosen point"} — click any point (a circle's centre, a line's end, a corner of the face) to go round that instead. 360° spreads them all the way round.`}
            </p>
            <button type="button" className="primary-button" onClick={() => makeSketchPattern()} disabled={selectionCount === 0}>
              Make pattern
            </button>
          </div>
        )}
        {tool === "sketchTransform" && (
          <div className="pattern-options">
            <label className="tool-option">
              Across
              <input value={showLength(moveDx, unit)} spellCheck={false} aria-label="Move across" onChange={(e) => setPatternOption({ moveDx: storeLength(e.target.value, unit) })} />
              <span className="muted">{unit}</span>
            </label>
            <label className="tool-option">
              Up
              <input value={showLength(moveDy, unit)} spellCheck={false} aria-label="Move up" onChange={(e) => setPatternOption({ moveDy: storeLength(e.target.value, unit) })} />
              <span className="muted">{unit}</span>
            </label>
            <label className="tool-option">
              Turn
              <input value={moveAngle} spellCheck={false} aria-label="Turn by" onChange={(e) => setPatternOption({ moveAngle: e.target.value })} />
              <span className="muted">°</span>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={moveCopy} onChange={(e) => setPatternOption({ moveCopy: e.target.checked })} />
              Make a copy (leave the original)
            </label>
            <p className="dialog-hint">Click the shapes to move. Turning goes round their middle (anticlockwise for plus).</p>
            <button type="button" className="primary-button" onClick={() => makeSketchTransform()} disabled={selectionCount === 0}>
              {moveCopy ? "Copy" : "Move"}
            </button>
          </div>
        )}
        <SketchExtrasPanel data={data} />
        {tool === "useEdge" && <p className="dialog-hint">Click edges of a part to copy them into this sketch. They follow the part if it changes.</p>}
        {!!linkInfo?.edges.length && (
          <div className="tool-option">
            <button type="button" className="text-button" onClick={() => copyFaceEdges()} title="Copy the face's outline and the edges of its holes into the sketch, ready to extrude">
              Use all the face's edges
            </button>
          </div>
        )}
        {tool === "sketchFillet" && (
          <label className="tool-option">
            Radius
            <input value={showLength(filletRadius, unit)} spellCheck={false} aria-label="Round radius" onChange={(e) => setSketchOptions({ filletRadius: storeLength(e.target.value, unit) })} />
            <span className="muted">{unit}</span>
          </label>
        )}
        {(() => {
          // One dimension selected: it can be switched between setting the size and just showing it.
          const dim = selection?.length === 1 ? data.constraints.find((c) => c.id === selection[0] && isDimension(c)) : undefined;
          if (!dim) return null;
          return (
            <div className="tool-option">
              <button
                type="button"
                className="text-button"
                onClick={toggleSketchDimensionDriven}
                title={dim.driven ? "Let this dimension set the size again (you can then double-click it to type a new size)" : "Keep this dimension just to show the size (in brackets) — it won't change the sketch"}
              >
                {dim.driven ? "Let it set the size" : "Just show the size"}
              </button>
              {(() => {
                // Between circles/arcs (or one and a line): measure to centres or edges, like Onshape's min/max.
                const to = measureToOf(data, dim);
                if (!to) return null;
                return (
                  <div className="segmented three" role="radiogroup" aria-label="Measure to">
                    {(
                      [
                        ["centre", "Centres", "Measure between the centres"],
                        ["nearest", "Near edges", "Measure the gap between the nearest edges (Onshape's minimum)"],
                        ["furthest", "Far edges", "Measure across the furthest edges (Onshape's maximum)"],
                      ] as const
                    ).map(([key, label, title]) => (
                      <button key={key} type="button" role="radio" aria-checked={to === key} className={to === key ? "selected" : ""} title={title} onClick={() => setSketchMeasureTo(key)}>
                        {label}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
          );
        })()}
        {confirmCancel && (
          <div className="dialog-error" role="alert">
            Discard your changes to this sketch? Click ✕ again to discard, or keep sketching.
          </div>
        )}
        {plane && (
          <ul className="sketch-status">
            {empty ? (
              <li className="muted">Start with Line, Rectangle or Circle in the toolbar.</li>
            ) : conflicts > 0 ? (
              <li className="error">
                <Icons.Warning size={15} /> {conflicts} constraint{conflicts > 1 ? "s" : ""} can't all be met — undo, or select the red ones and delete
              </li>
            ) : freedom === 0 ? (
              <li className="ok">
                <Icons.Tick size={15} /> Fully defined
              </li>
            ) : (
              <li className="free">
                Under-defined: {freedom} way{freedom > 1 ? "s" : ""} it can still move or resize. Blue = free, {theme === "dark" ? "white" : "black"} = fixed.
              </li>
            )}
            {regions && !empty && (
              <li className={regions.regions.length ? "muted" : "warn"}>
                {regions.regions.length
                  ? `${regions.regions.length} closed shape${regions.regions.length > 1 ? "s" : ""} ready to extrude`
                  : "No closed shapes yet — Extrude needs a closed outline."}
              </li>
            )}
            {(() => {
              const lost = lostLinksMessage(data, linkInfo);
              const lostIds = data.curves.filter((c) => "link" in c && c.link && linkInfo?.links[c.id] === null).map((c) => c.id);
              return lost ? (
                <li className="warn">
                  <Icons.Warning size={15} /> {lost}{" "}
                  {lostIds.length > 0 && (
                    <button type="button" className="text-button" onClick={() => useStore.getState().setSketchSelection(lostIds)}>
                      Select {lostIds.length === 1 ? "it" : "them"}
                    </button>
                  )}
                  {linkInfo?.faceLost && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => useStore.getState().repickSketchPlane()}
                    >
                      Pick the face again
                    </button>
                  )}
                </li>
              ) : linkInfo?.edges.length && empty ? (
                <li className="muted">The face's edges show faintly: snap to their corners, middles and centres, or click one to dimension to it.</li>
              ) : null;
            })()}
            {regions?.problems.map((p) => (
              <li key={p} className="warn">
                {p}
              </li>
            ))}
            {selectionCount > 0 && (
              <li className="muted">
                {selectionCount} selected — use the constraint buttons, Q for construction, or Delete.
              </li>
            )}
          </ul>
        )}
        {message && (
          <p className={message.tone === "error" ? "dialog-error" : "dialog-hint"} role={message.tone === "error" ? "alert" : "status"}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
