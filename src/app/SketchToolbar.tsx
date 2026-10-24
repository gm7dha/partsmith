import type { ReactNode } from "react";

import { useStore, type SketchTool } from "../model/store";
import { RELATION_HINTS, RELATION_LABELS, type RelationTool } from "../sketch/ops";
import { RELATION_SYMBOLS } from "../sketch/layout";
import { Icons } from "./icons";
import { ToolGroupButton } from "./ToolGroupButton";
import { detectPlatform, shortcut } from "./platform";
import { applySketchRelation, deleteSketchSelection, insertImageFile, pickFile, setSketchTool, toggleSketchConstruction } from "./sketchActions";

const TOOLS: { tool: SketchTool; label: string; key: string; icon: ReactNode; hint: string }[] = [
  { tool: "select", label: "Select", key: "Esc", icon: <Icons.Select />, hint: "Click to select, drag to move" },
  { tool: "line", label: "Line", key: "L", icon: <Icons.Line />, hint: "Click to start, keep clicking to chain lines, Esc to stop" },
  { tool: "rectangle", label: "Rectangle", key: "R", icon: <Icons.Rectangle />, hint: "Click two opposite corners" },
  { tool: "centreRectangle", label: "Centre rect", key: "", icon: <Icons.CentreRectangle />, hint: "Click the centre, then a corner" },
  { tool: "alignedRectangle", label: "Aligned rect", key: "", icon: <Icons.AlignedRectangle />, hint: "Click two corners along one side (at any angle), then move out to set the width" },
  { tool: "circle", label: "Circle", key: "C", icon: <Icons.Circle />, hint: "Click the centre, then a point on the edge" },
  { tool: "circle3", label: "3-point circle", key: "", icon: <Icons.Circle3 />, hint: "Click three points the circle passes through" },
  { tool: "arc", label: "Arc", key: "A", icon: <Icons.Arc />, hint: "Click both ends, then a point the arc passes through" },
  { tool: "centreArc", label: "Centre arc", key: "", icon: <Icons.CentreArc />, hint: "Click the centre, then where the arc starts, then where it ends" },
  { tool: "tangentArc", label: "Tangent arc", key: "", icon: <Icons.TangentArc />, hint: "Click the end of a line or arc, then where the arc should finish — it carries on smoothly" },
  { tool: "spline", label: "Spline", key: "", icon: <Icons.Spline />, hint: "Click points for a smooth curve to pass through. Click the first point again to close it, or Esc to finish. Afterwards, select it and drag the green handles at its points to reshape it" },
  { tool: "conic", label: "Conic", key: "", icon: <Icons.Conic />, hint: "Click both ends, then the corner the curve bends towards. Set how full it is (0.5 = a parabola) in the sketch panel" },
  { tool: "ellipse", label: "Ellipse", key: "", icon: <Icons.Ellipse />, hint: "Click the centre, then the end of its length, then how wide it is" },
  { tool: "slot", label: "Slot", key: "S", icon: <Icons.Slot />, hint: "Click both end centres, then move out to set the width" },
  { tool: "polygon", label: "Polygon", key: "G", icon: <Icons.Polygon />, hint: "Click the centre, then a corner (set the number of sides in the sketch panel)" },
  { tool: "point", label: "Point", key: "P", icon: <Icons.Point />, hint: "Click to place a point" },
  { tool: "dimension", label: "Dimension", key: "D", icon: <Icons.Dimension />, hint: "Click a line or circle (or two things), then where the value goes — where you put it picks across, up or straight" },
  { tool: "sketchFillet", label: "Round", key: "", icon: <Icons.CornerRound />, hint: "Click a corner where two lines or arcs meet to round it (set the radius in the sketch panel)" },
  { tool: "extend", label: "Extend", key: "", icon: <Icons.Extend />, hint: "Click near the end of a line or arc to lengthen it up to the next line, arc or circle" },
  { tool: "split", label: "Split", key: "", icon: <Icons.SplitLine />, hint: "Click a line, arc, spline or part of an ellipse where you want to break it into two (the pieces keep exactly the same shape)" },
  { tool: "trim", label: "Trim", key: "T", icon: <Icons.Trim />, hint: "Click a piece of a line, arc, circle, spline or ellipse to cut it away up to where other curves cross it" },
  { tool: "offset", label: "Offset", key: "O", icon: <Icons.Offset />, hint: "Click a shape's edge on the side to offset towards — a copy that far away that follows the original (set the distance in the sketch panel). Splines and ellipses too" },
  { tool: "mirror", label: "Mirror", key: "M", icon: <Icons.Mirror />, hint: "Click the line to mirror about, then the shapes to copy across (or select the shapes first). The copies follow the originals" },
  { tool: "sketchTransform", label: "Move / copy", key: "", icon: <Icons.Move />, hint: "Click shapes, then move, turn or copy them by the amounts in the sketch panel" },
  { tool: "sketchPattern", label: "Pattern", key: "", icon: <Icons.SketchPattern />, hint: "Click shapes to repeat them in a row or round a centre (set how many and how far apart in the sketch panel). The copies follow the originals" },
  { tool: "useEdge", label: "Use", key: "U", icon: <Icons.UseEdge />, hint: "Click edges of a part to copy them into the sketch (they follow the part if it changes)" },
  { tool: "intersect", label: "Intersect", key: "", icon: <Icons.Intersect />, hint: "Click a face of a part the sketch passes through: where the sketch cuts it comes in as dashed lines that follow the part" },
  { tool: "text", label: "Text", key: "", icon: <Icons.Text />, hint: "Type the words in the sketch panel, then click where they go. Their letters are shapes you can extrude" },
];

/** Tools shown as one button with a ▾ list (the first is shown until another is used). */
const FAMILIES: { name: string; tools: SketchTool[] }[] = [
  { name: "rectangle", tools: ["rectangle", "centreRectangle", "alignedRectangle"] },
  { name: "circle", tools: ["circle", "circle3", "ellipse"] },
  { name: "arc", tools: ["arc", "centreArc", "tangentArc"] },
  { name: "spline", tools: ["spline", "conic"] },
  { name: "trim", tools: ["trim", "extend", "split"] },
  { name: "copy", tools: ["mirror", "sketchPattern", "sketchTransform"] },
  { name: "use", tools: ["useEdge", "intersect"] },
];

const RELATIONS: RelationTool[] = [
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
  "normal",
  "curvature",
  "fix",
];

/** Replaces the main toolbar while a sketch is open, like Onshape's sketch toolbar. */
export function SketchToolbar() {
  const tool = useStore((s) => s.sketch?.tool ?? "select");
  const construction = useStore((s) => s.sketch?.construction ?? false);
  const canUndo = useStore((s) => (s.sketch?.past.length ?? 0) > 0);
  const canRedo = useStore((s) => (s.sketch?.future.length ?? 0) > 0);
  const hasSelection = useStore((s) => (s.sketch?.selection.length ?? 0) > 0);
  const hasPlane = useStore((s) => !!s.editing?.draft.sketch?.plane);
  const sketchUndo = useStore((s) => s.sketchUndo);
  const sketchRedo = useStore((s) => s.sketchRedo);
  const platform = detectPlatform();

  return (
    <div className="toolbar sketch-toolbar" role="toolbar" aria-label="Sketch tools">
      <div className="tool-group">
        <ToolBtn label="Undo" icon={<Icons.Undo />} onClick={sketchUndo} disabled={!canUndo} title={`Undo in this sketch (${shortcut(platform, "Z")})`} />
        <ToolBtn label="Redo" icon={<Icons.Redo />} onClick={sketchRedo} disabled={!canRedo} title={`Redo in this sketch (${shortcut(platform, platform === "mac" ? "Z" : "Y", { shift: platform === "mac" })})`} />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        {TOOLS.map((t) => {
          const family = FAMILIES.find((f) => f.tools.includes(t.tool));
          if (family && family.tools[0] !== t.tool) return null;
          if (family)
            return (
              <ToolGroupButton
                key={family.name}
                id={`sketch-${family.name}`}
                name={family.name}
                items={family.tools.map((k) => {
                  const d = TOOLS.find((x) => x.tool === k)!;
                  return {
                    key: d.tool,
                    label: d.label,
                    icon: d.icon,
                    title: `${d.label}${d.key ? ` (${d.key})` : ""} — ${d.hint}`,
                    shortcut: d.key || undefined,
                    active: tool === d.tool,
                    disabled: !hasPlane,
                    onClick: () => setSketchTool(d.tool),
                  };
                })}
              />
            );
          return (
            <ToolBtn
              key={t.tool}
              label={t.label}
              icon={t.icon}
              active={tool === t.tool}
              disabled={!hasPlane}
              onClick={() => setSketchTool(t.tool)}
              title={`${t.label}${t.key ? ` (${t.key})` : ""} — ${t.hint}`}
            />
          );
        })}
        <ToolGroupButton
          id="sketch-insert"
          name="insert"
          items={[
            {
              key: "dxf",
              label: "Insert DXF",
              icon: <Icons.InsertDxf />,
              title: "Insert DXF — bring a 2D drawing (DXF file) into this sketch as lines, arcs and circles you can edit",
              disabled: !hasPlane,
              onClick: () => useStore.getState().setSketchOptions({ dxfOpen: true }),
            },
            {
              key: "image",
              label: "Insert image",
              icon: <Icons.Picture />,
              title: "Insert image — lay a picture on the sketch to trace over (it isn't part of the shape)",
              disabled: !hasPlane,
              onClick: () => pickFile("image/*", (f) => void insertImageFile(f)),
            },
          ]}
        />
        <ToolBtn
          label="Construction"
          icon={<Icons.Construction />}
          active={construction}
          disabled={!hasPlane}
          onClick={toggleSketchConstruction}
          title="Construction (Q) — dashed helper geometry that isn't extruded. Toggles the selection, or new shapes if nothing is selected."
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group relations">
        {RELATIONS.map((r) => (
          <button
            key={r}
            className="relation-button"
            disabled={!hasPlane}
            onClick={() => applySketchRelation(r)}
            title={`${RELATION_LABELS[r]} — ${RELATION_HINTS[r]}`}
            aria-label={RELATION_LABELS[r]}
          >
            <span className="relation-symbol">{RELATION_SYMBOLS[r]}</span>
            <span>{RELATION_LABELS[r]}</span>
          </button>
        ))}
      </div>
      <div className="toolbar-spacer" />
      <div className="tool-group">
        <ToolBtn label="Delete" icon={<Icons.Trash />} onClick={deleteSketchSelection} disabled={!hasSelection} title="Delete the selection (Delete)" />
      </div>
    </div>
  );
}

function ToolBtn({
  label,
  icon,
  onClick,
  disabled,
  active,
  title,
}: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button className={`tool-button${active ? " active" : ""}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-label={label} aria-pressed={active}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
