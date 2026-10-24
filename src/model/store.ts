import { deleteItems } from "../sketch/ops";
import { followLinks, pruneReferences, type SketchLinkInfo } from "../sketch/links";
import { isExtraId, keepSketchExtras, withoutEmptyExtras } from "../sketch/sketchText";
import { create } from "zustand";

import type { PartMesh } from "../kernel/protocol";
import {
  addFeature,
  insertFeatureAfter,
  newId,
  commit,
  createFeature,
  emptyDocument,
  historyOf,
  parseDocument,
  redo as redoHistory,
  removeFeature,
  renameFeature,
  renameFolder,
  setFolder,
  renamePart,
  replaceFeature,
  setSuppressed,
  undo as undoHistory,
  type History,
} from "./document";
import { sameRef, type TopoPick } from "../geometry/topoRef";
import type { SketchPlane } from "../sketch/planes";
import type { SketchData } from "../sketch/types";
import { setCurrentScope } from "./expr";
import { addConfiguration, removeConfiguration, renameConfiguration, switchConfiguration } from "./configurations";
import { framesOf, planeAsSketchPlane, refreshDocumentPlanes } from "../sketch/planeFeature";
import { lengthUnit, setLengthUnit, startingLength, storeLength, type LengthUnit } from "./units";
import { applyVariables, resolveVariables, type Variable } from "./variables";
import { isPatternFeature, isPickFeature, isSketchSolid, isSolidFeature, resolveParams } from "./features";
import { setMirrorReference } from "./patternRefs";
import { defaultAxis } from "../sketch/axis";
import type { Assembly, AssemblyPattern, ExplodeStep, Replicate, Drawing, Feature, FeatureType, ImportedFile, Instance, Mate, MateConnector, MateRelation, MateType, JuraCADDocument, PartProperties } from "./types";
import { boundsOfVertices } from "../assembly/assembly";
import { nextPatternName, removePattern, syncPattern } from "../assembly/patterns";
import { nextReplicateName, removeReplicate, replicateSource, syncReplicate } from "../assembly/replicate";
import { matchingConnectors } from "../assembly/connectors";
import { makeGroup, removeGroup, renameGroup } from "../assembly/groups";
import { duplicateInstances, placedBox, replaceInstancePart, type Box3 } from "../assembly/assembly";
import { putExplodeStep, removeExplodeStep } from "../assembly/explode";
import { findMesh, meshIdOf } from "../assembly/configured";
import { addAssembly, applyPosition, updateAssembly, insertInstance, putMate, putRelation, removeAssembly, removeInstances, removeMate, removePosition, removeRelation, savePosition, renameAssembly, setExplode, settlePlacements, settleSolved, updateInstance } from "../assembly/assembly";
import { MATE_TYPES, nextMateName, pickConnector, samePieceClick, solveWithParts } from "../assembly/mates";
import { insertProblem, insertSubAssembly, instanceAt, leafKey, ownBox, whereUsed } from "../assembly/subassembly";
import { setSuppressed as setInstancesOff } from "../assembly/suppress";
import { setPartProperties as setPartPropertiesIn } from "../assembly/properties";
import { moveFeature as moveFeatureIn } from "./reorder";
import { DEFAULT_MATERIAL } from "./materials";
import { addDrawing as addDrawingTo, removeDrawing as removeDrawingFrom, renameDrawing as renameDrawingIn, updateDrawing } from "../drawing/drawing";
import { withDragChange, type DragChange } from "../assembly/drag";
import type { Placement } from "../assembly/math";
import { importName } from "./importFile";
import { addStudio, inStudio, MAIN_STUDIO, removeStudio, renameStudio, studioExists, studioFeatures, studioView } from "./studios";


/** Two sketch planes in the same place (to within a micron), whatever face they remember. */
function samePlace(a: SketchPlane, b: SketchPlane): boolean {
  if (a.kind !== "face" || b.kind !== "face") return a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);
  const near = (p: number[], q: number[]) => p.every((v, i) => Math.abs(v - q[i]) < 1e-3);
  return near(a.origin, b.origin) && near(a.u, b.u) && near(a.v, b.v);
}

/** No sketch links (one shared object, so selectors stay stable). */
const NO_LINKS: Record<string, SketchLinkInfo> = {};
/** No drawing dimensions selected (one shared array, so selectors stay stable). */
const NO_DIMS: string[] = [];
export interface SelectionItem {
  partId: string;
  kind: "face" | "edge";
  /** Face or edge number within the part. */
  index: number;
}

/** What a picked face or edge looks like, so a feature can find it again after rebuilds. */
export function pickFor(parts: PartMesh[], item: SelectionItem): TopoPick | null {
  const part = parts.find((p) => p.id === item.partId);
  const ref = item.kind === "edge" ? part?.edgeRefs?.[item.index] : part?.faceRefs?.[item.index];
  if (!ref || (ref.kind === "edge" ? ref.curve : ref.surface) === "UNKNOWN") return null;
  return { partId: item.partId, ref };
}

/** The default planes, as in Onshape. Top = XY, Front = XZ, Right = YZ. */
export type PlaneName = "Top" | "Front" | "Right";
/** Default geometry listed at the top of the feature list. */
export type DatumName = "Origin" | PlaneName;

export interface Editing {
  mode: "create" | "edit";
  draft: Feature;
}

/** Drawing tools: select, the smart Dimension, baseline / chain / ordinate runs, and section. */
export type DrawingTool = "select" | "dimension" | "baseline" | "chain" | "ordinate" | "section" | "auxiliary" | "breakout" | "shorten" | "note" | "detail" | "holeCallout" | "chamfer" | "arcLength" | "datum" | "fcf" | "finish";

export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "centreRectangle"
  | "alignedRectangle"
  | "circle3"
  | "centreArc"
  | "circle"
  | "arc"
  | "tangentArc"
  | "spline"
  | "conic"
  | "ellipse"
  | "point"
  | "dimension"
  | "slot"
  | "polygon"
  | "sketchFillet"
  | "trim"
  | "extend"
  | "split"
  | "offset"
  | "mirror"
  | "sketchPattern"
  | "sketchTransform"
  | "useEdge"
  | "text"
  | "intersect";

/** State while a sketch is open for editing. */
export interface SketchSession {
  /** Sketch undo history (separate from the document's, like Onshape). */
  past: SketchData[];
  future: SketchData[];
  tool: SketchTool;
  /** Selected point, curve and constraint ids. */
  selection: string[];
  /** New lines, circles and arcs are construction geometry. */
  construction: boolean;
  /** Hint or problem shown in the sketch panel. */
  message: { text: string; tone: "info" | "error" } | null;
  /** Dimension whose value box is open. */
  editingDimension: string | null;
  /** Dimensions offered just after drawing a shape (their value box opens straight away): Enter keeps one, Esc drops them. */
  provisional: string[];
  /** Polygon tool: number of sides. */
  polygonSides: number;
  /** Polygon tool: the pointer sets a corner (the size across corners) or the middle of a side (across flats). */
  polygonAcross?: "corners" | "flats";
  /** Conic tool: how full new conics are (0.5 = a parabola). */
  conicRho?: number;
  /** Corner-rounding tool: radius as typed. */
  filletRadius: string;
  /** Offset tool: distance as typed. */
  offsetDistance: string;
  /** Pattern tool: in a row or round a centre. */
  patternKind: "linear" | "circular";
  /** Pattern tool: how many, counting the original. */
  patternCount: number;
  /** Linear pattern: gap between copies as typed. */
  patternSpacing: string;
  /** Linear pattern: direction in degrees from X. Circular pattern: angle to spread over. */
  patternAngle: string;
  /** Circular pattern: the point to go round. */
  patternCentre: string;
  /** Linear pattern: the next click on a line sets the direction. */
  patternDirectionPick?: boolean;
  /** Linear pattern: the line the direction came from, so the copies follow it. */
  patternLine?: string;
  /** Move / copy tool: how far across and up (as typed), the turn (degrees, about the selection's middle), and whether to copy. */
  moveDx: string;
  moveDy: string;
  moveAngle: string;
  moveCopy: boolean;
  /** Text tool: the settings for new text (a selected text shows its own instead). */
  textValue?: string;
  textSize?: string;
  textAngle?: string;
  textFont?: "regular" | "bold";
  textAnchorAt?: "start" | "centre";
  /** Bumped to put the cursor in the sketch panel's text box (a double-click on text). */
  textFocus?: number;
  /** Intersect: clicking a face takes where the sketch cuts the whole part, not just that face. */
  intersectWhole?: boolean;
  /** Insert DXF: the panel's box is open, and the scale to bring the next file in at. */
  dxfOpen?: boolean;
  dxfScale?: string;
}

/** Section view (display only — not saved): cut the view along a default plane. */
export interface SectionView {
  plane: PlaneName;
  /** Position of the cut along the plane's direction, mm. */
  offset: number;
  /** Show the other side. */
  flip: boolean;
}

/** A mate being made or changed; its two connectors may not be picked yet. */
export type MateDraft = Omit<Mate, "a" | "b"> & { a?: MateConnector; b?: MateConnector };

export type DialogName = "check" | "export" | "help" | "whatsNew" | "flatPattern" | "variables" | "configurations" | "insert" | null;

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "success" | "error";
}

export interface AppState {
  history: History;
  editing: Editing | null;
  /** Present while the feature being edited is a sketch. */
  sketch: SketchSession | null;
  /** Feature highlighted in the feature list. */
  selectedFeatureId: string | null;
  /** The section view, when one is on. */
  section: SectionView | null;
  /** The print bed preview, when on: which printer (or a custom size). */
  printBed: { printer: string; custom?: [number, number, number] } | null;
  /** Faces and edges picked in the viewport. */
  selection: SelectionItem[];
  hiddenParts: string[];
  /** Parts drawn see-through (display only, not saved). */
  transparentParts: string[];
  /** Part Studio: show sheet metal parts laid out flat instead of folded. */
  showFlat: boolean;
  /** Whole parts picked in the Parts list (for hiding, colouring or exporting several at once). */
  selectedParts: string[];
  /** Default plane picked in the list or viewport (planes and faces aren't selected together). */
  selectedPlane: PlaneName | null;
  /** Plane whose row the pointer is over in the feature list (highlighted in the viewport). */
  listHoverPlane: PlaneName | null;
  hiddenDatums: DatumName[];

  kernelStatus: "loading" | "ready" | "failed";
  kernelError: string | null;
  rebuildBusy: boolean;
  parts: PartMesh[];
  featureErrors: Record<string, string>;
  /** Sketches on part faces or using part edges (by feature id), as found on the latest rebuild. */
  sketchLinks: Record<string, SketchLinkInfo>;
  lastRebuildMs: number | null;

  dialog: DialogName;
  toast: Toast | null;
  /** The tab on show: an assembly's id, or null for the Part Studio. */
  activeTab: string | null;
  /** Instances selected in the assembly on show. */
  asmSelection: string[];
  /** Instances hidden in the 3D view. */
  hiddenInstances: string[];
  /** The mate dialog, while open. */
  mateDraft: { mode: "create" | "edit"; mate: MateDraft } | null;
  /** Drawing tab: what clicks on the sheet do, and the selected dimension. */
  drawingTool: DrawingTool;
  selectedDim: string | null;
  /** Every selected dimension and note (several when box-selected or Ctrl-clicked; selectedDim is set only when there's one). */
  selectedDims: string[];
  /** Part Studio rolled back to just after this feature (Onshape's rollback bar); null = showing everything. */
  rollbackTo: string | null;
  /** What a mouse drag in an assembly is changing, while the button is held. */
  dragPreview: DragChange | null;
  /** Mate whose movement is being animated in the 3D view. */
  animatingMate: string | null;
  setAnimatingMate: (id: string | null) => void;
  /** The design as last saved to (or opened from) a file; compare with history.present to see unsaved changes. */
  savedDoc: JuraCADDocument | null;
  /** Name of that file, e.g. "Bracket.juracad". */
  fileName: string | null;

  // actions
  startCreate: (type: FeatureType) => void;
  startEdit: (id: string) => void;
  /** Start importing a STEP or STL file (opens the Import dialog with a preview). */
  startImport: (file: ImportedFile) => void;
  setDraftParam: (key: string, value: string) => void;
  setDraftField: (patch: Partial<Pick<Feature, "name" | "operation" | "sketchRef" | "areas" | "extrude" | "revolve" | "picks" | "pattern" | "mirror" | "hole" | "transform" | "import" | "pathRef" | "sections" | "text" | "planeDef" | "booleanDef" | "splitDef" | "replaceDef" | "flipSide" | "closeCorners" | "neutral" | "deleteParts" | "fastener" | "derived" | "reliefShape" | "cornerRelief" | "surface" | "hollow" | "flangePosition" | "mitreCorners" | "keepOtherSide" | "extendTo" | "bothSides" | "continuity" | "breakStyle" | "leaveOpen" | "chamferType">>) => void;
  /** Fillet/chamfer: add a picked edge or face, or remove it if it's already picked. */
  toggleDraftPick: (pick: TopoPick) => void;
  /** Mirror/pattern: add a feature to repeat, or remove it if it's already there. */
  toggleDraftSource: (featureId: string) => void;
  /** Mirror: the plane to mirror across. */
  setDraftMirrorPlane: (plane: SketchPlane) => void;
  /** Open a new sketch (plane may be chosen later). */
  startSketch: (plane: SketchPlane | null) => void;
  setSketchPlane: (plane: SketchPlane) => void;
  /** The sketch's face can't be found: let the next click on a face or plane put the sketch there. */
  repickSketchPlane: () => void;
  /** Replace the sketch being edited. `record` adds an undo step. */
  updateSketch: (data: SketchData, opts?: { record?: boolean; selection?: string[] }) => void;
  /** Record an undo step for a drag that's finished (`before` = sketch when the drag began). */
  recordSketchStep: (before: SketchData) => void;
  sketchUndo: () => void;
  sketchRedo: () => void;
  setSketchTool: (tool: SketchTool) => void;
  setSketchSelection: (ids: string[]) => void;
  setSketchMessage: (text: string | null, tone?: "info" | "error") => void;
  setSketchConstruction: (on: boolean) => void;
  setEditingDimension: (id: string | null) => void;
  /** Offer these new dimensions (see SketchSession.provisional); the first one's box opens. */
  offerDimensions: (ids: string[]) => void;
  /** Keep the offered dimension being edited, and move on to the next one offered (if any). */
  keepOfferedDimension: (id: string) => void;
  /** Drop any offered dimensions not kept yet. */
  discardOfferedDimensions: () => void;
  setSketchOptions: (patch: Partial<Pick<SketchSession, "polygonSides" | "polygonAcross" | "conicRho" | "filletRadius" | "offsetDistance" | "patternKind" | "patternCount" | "patternSpacing" | "patternAngle" | "patternCentre" | "patternDirectionPick" | "patternLine" | "moveDx" | "moveDy" | "moveAngle" | "moveCopy" | "textValue" | "textSize" | "textAngle" | "textFont" | "textAnchorAt" | "textFocus" | "intersectWhole" | "dxfOpen" | "dxfScale">>) => void;
  commitDraft: () => boolean;
  cancelDraft: () => void;
  /**
   * Turn features off (Delete face's "fillets in the way" prompt). With
   * `commit`, the open feature is added in the same undo step; otherwise it's dropped.
   */
  suppressThenFinish: (ids: string[], commit: boolean) => void;
  deleteFeature: (id: string) => void;
  /** Roll the Part Studio back to just after a feature (null = roll to the end). */
  setRollback: (id: string | null) => void;
  /** Move a feature to just before another (null = the end), if what it uses stays above it. One undo step. */
  moveFeature: (id: string, beforeId: string | null) => void;
  toggleSuppressed: (id: string) => void;
  renameFeature: (id: string, name: string) => void;
  /** Feature list folders: put features in one (null takes them out), or rename one. */
  setFeatureFolder: (ids: string[], folder: string | null) => void;
  renameFeatureFolder: (from: string, to: string) => void;
  renameDocument: (name: string) => void;
  /** Name a part (blank goes back to "Part N"). One undo step. */
  renamePart: (partId: string, name: string) => void;
  /** Set what a part is made of (null = back to PLA). One undo step. */
  setPartMaterial: (partId: string, material: string | null) => void;
  /** A part's number, description and own properties, for parts lists (blank ones are dropped). */
  setPartProperties: (partId: string, props: PartProperties) => void;
  /** Colour a part (null = back to the default grey). One undo step. */
  setPartColour: (partId: string, colour: string | null) => void;
  /** Replace the variable list (one undo step); renames are followed everywhere. */
  setVariables: (variables: Variable[]) => void;
  /** Configurations: keep the current state as a new one (and show it), show another, rename or forget one. */
  addConfiguration: (name: string) => void;
  switchConfiguration: (id: string) => void;
  renameConfiguration: (id: string, name: string) => void;
  removeConfiguration: (id: string) => void;
  newDocument: () => void;
  /** Replace the design with one opened from a file (undoable). */
  openDocument: (doc: JuraCADDocument, fileName: string) => void;
  /** Note that the current design has just been saved to this file. */
  markSaved: (fileName: string) => void;
  /**
   * Live with Claude: show Claude's change to the design as one undo step
   * (`replace`: a whole new design, e.g. one Claude opened). The label
   * ("Claude: added Extrude 2") is shown as a note.
   */
  applyClaudeChange: (doc: JuraCADDocument, studio: string, label: string, replace: boolean) => void;
  /** Add an assembly tab and switch to it. */
  addAssembly: () => void;
  /** Add a Part Studio tab and switch to it. */
  addPartStudio: () => void;
  /** Add a drawing tab (of the part selected or last shown) and switch to it. */
  addDrawing: () => void;
  /** Change the drawing on show (one undo step). */
  changeDrawing: (fn: (d: Drawing) => Drawing) => void;
  renameDrawing: (id: string, name: string) => void;
  removeDrawing: (id: string) => void;
  renamePartStudio: (id: string, name: string) => void;
  removePartStudio: (id: string) => void;
  /** Show the Part Studio (null) or an assembly. */
  setActiveTab: (id: string | null) => void;
  removeAssembly: (id: string) => void;
  renameAssembly: (id: string, name: string) => void;
  /** Put a copy of a part into the assembly on show. */
  insertInstance: (part: { id: string; name: string }, placement?: Placement) => void;
  /** Put a copy of another assembly into the assembly on show, as one piece (refused, with a message, if it would go round in a circle). */
  insertSubAssembly: (assemblyId: string, placement?: Placement) => void;
  updateInstance: (id: string, patch: Partial<Pick<Instance, "name" | "placement" | "fixed" | "configuration">>) => void;
  removeInstances: (ids: string[]) => void;
  setAsmSelection: (ids: string[]) => void;
  toggleInstanceHidden: (id: string) => void;
  /** Switch instances off (Onshape's Suppress) or back on; the others stay where they are. */
  setInstancesSuppressed: (ids: string[], suppressed: boolean) => void;
  startMate: (type: MateType) => void;
  editMate: (id: string) => void;
  setMateDraft: (patch: Partial<MateDraft>) => void;
  /** A face or edge clicked while the mate dialog is open: fills the first connector, then the second. */
  pickMateConnector: (c: MateConnector) => void;
  /** Save the mate (false if it isn't ready). */
  commitMateDraft: () => boolean;
  cancelMateDraft: () => void;
  deleteMate: (id: string) => void;
  toggleMateSuppressed: (id: string) => void;
  /** Exploded view of the assembly on show: how far apart (null = together). */
  setExplode: (amount: number | null) => void;
  /** Add or change a mate relation in the assembly on show (one undo step). */
  putRelation: (relation: MateRelation) => void;
  removeRelation: (id: string) => void;
  /** Named positions in the assembly on show: save the mates' amounts now, go back to one, or forget one. */
  savePosition: (name: string) => void;
  applyPosition: (id: string) => void;
  removePosition: (id: string) => void;
  /** Show and type lengths in millimetres or inches. */
  setUnits: (unit: LengthUnit) => void;
  /** Light or dark appearance (see app/theme.ts; not saved in designs). */
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  /** The exploded view's spread while its slider is being dragged (not saved until let go). */
  explodePreview: number | null;
  setExplodePreview: (amount: number | null) => void;
  /** The assembly pattern whose settings are open (changes apply straight away). */
  editingPattern: string | null;
  setEditingPattern: (id: string | null) => void;
  /** Repeat the selected instances (a linear pattern to start with) and open its settings. */
  /** Pattern (or, with "mirror", Mirror) the selected instances. */
  createPattern: (kind?: "mirror") => void;
  updatePattern: (id: string, patch: Partial<Omit<AssemblyPattern, "id">>) => void;
  deletePattern: (id: string) => void;
  /** Group: lock the selected parts together where they are. */
  createGroup: () => void;
  /** Ungroup: the parts stay where they are but move separately again. */
  deleteGroup: (id: string) => void;
  renameGroup: (id: string, name: string) => void;
  /** Replicate: copy the selected part into every hole matching the one it's mated into. */
  createReplicate: () => void;
  /** Look for matching holes again (after the part changed). */
  refreshReplicate: (id: string) => void;
  deleteReplicate: (id: string) => void;
  /** Copy the selected instances (and the mates between them), placed beside everything. */
  duplicateInstances: () => void;
  /** Show another part in an instance (and its pattern and Replicate copies), keeping its mates. */
  replaceInstancePart: (instanceId: string, partId: string) => void;
  /** Exploded view steps: move the selected parts (add), change or remove a step. */
  addExplodeStep: () => void;
  updateExplodeStep: (id: string, patch: Partial<Omit<ExplodeStep, "id">>) => void;
  removeExplodeStep: (id: string) => void;
  setDragPreview: (change: DragChange | null) => void;
  setDrawingTool: (tool: DrawingTool) => void;
  selectDim: (id: string | null) => void;
  selectDims: (ids: string[]) => void;
  /** Keep what the drag did (one undo step). */
  commitDrag: () => void;
  undo: () => void;
  redo: () => void;
  selectFeature: (id: string | null) => void;
  setSelection: (items: SelectionItem[]) => void;
  toggleHidden: (partId: string) => void;
  setShowFlat: (on: boolean) => void;
  setSelectedParts: (ids: string[]) => void;
  /** Boolean dialog: add a part to (or take it off) the list being picked. */
  toggleBooleanPart: (partId: string) => void;
  /**
   * Copy parts (a Move/copy feature with "copy" ticked), placed just to the
   * side. One part opens the Move/copy dialog to adjust; several are copied straight away.
   */
  duplicateParts: (ids: string[]) => void;
  /** Hide or show several parts at once. */
  setPartsHidden: (ids: string[], hidden: boolean) => void;
  /** Join parts into one (adds a Boolean join feature, one undo step). */
  mergeParts: (ids: string[]) => void;
  /** Draw parts see-through, or solid again. */
  setPartsTransparent: (ids: string[], on: boolean) => void;
  selectPlane: (plane: PlaneName | null) => void;
  setListHoverPlane: (plane: PlaneName | null) => void;
  toggleDatum: (datum: DatumName) => void;
  openDialog: (d: DialogName) => void;
  setSection: (section: SectionView | null) => void;
  setPrintBed: (printBed: { printer: string; custom?: [number, number, number] } | null) => void;
  showToast: (text: string, tone?: Toast["tone"]) => void;

  // set by the kernel connection
  setKernelStatus: (status: AppState["kernelStatus"], error?: string) => void;
  setRebuildBusy: (busy: boolean) => void;
  setRebuildResult: (parts: PartMesh[], featureErrors: Record<string, string>, ms: number, rebuilt?: string[], studioOrder?: string[], sketchLinks?: Record<string, SketchLinkInfo>) => void;
}

// These browser-storage keys keep the app's old name (PartSmith) on purpose: changing them
// would lose the design people have kept in this browser.
export const STORAGE_KEY = "partsmith.document.v1";
/** Which file the design in browser storage was last saved to, so "Saved" survives a page refresh. */
const FILE_KEY = "partsmith.file.v1";

/** A short fingerprint of a design, to tell whether it changed since it was saved. */
export function fingerprint(doc: JuraCADDocument): string {
  const text = JSON.stringify(doc);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h >>> 0}`;
}

function rememberFile(doc: JuraCADDocument, fileName: string | null) {
  try {
    if (fileName) globalThis.localStorage?.setItem(FILE_KEY, JSON.stringify({ fileName, print: fingerprint(doc) }));
    else globalThis.localStorage?.removeItem(FILE_KEY);
  } catch {
    // storage blocked: only the label is affected
  }
}

/** The saved-file label for a design just loaded from browser storage. */
function savedFileFor(doc: JuraCADDocument): { savedDoc: JuraCADDocument | null; fileName: string | null } {
  try {
    const raw = globalThis.localStorage?.getItem(FILE_KEY);
    if (raw) {
      const f = JSON.parse(raw) as { fileName?: unknown; print?: unknown };
      if (typeof f.fileName === "string") return { savedDoc: f.print === fingerprint(doc) ? doc : null, fileName: f.fileName };
    }
  } catch {
    // ignore
  }
  return { savedDoc: null, fileName: null };
}

function loadSavedDocument(): JuraCADDocument {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const doc = parseDocument(JSON.parse(raw));
      if (doc) return doc;
    }
  } catch {
    // storage unavailable or corrupt: start fresh
  }
  return emptyDocument();
}

let toastCounter = 0;

const newSession = (): SketchSession => ({
  past: [],
  future: [],
  tool: "line",
  selection: [],
  construction: false,
  message: null,
  editingDimension: null,
  provisional: [],
  polygonSides: 6,
  filletRadius: "2",
  offsetDistance: "2",
  patternKind: "linear",
  patternCount: 3,
  patternSpacing: "10",
  patternAngle: "0",
  patternCentre: "origin",
  moveDx: "10",
  moveDy: "0",
  moveAngle: "0",
  moveCopy: false,
});

/** Is this id (point, curve or constraint) still in the sketch? */
const existsIn = (d: SketchData, id: string) =>
  d.points.some((p) => p.id === id) || d.curves.some((c) => c.id === id) || d.constraints.some((c) => c.id === id) || id === "origin" || isExtraId(d, id);

export const useStore = create<AppState>((set, get) => {
  /** Apply a document change and record it for undo. */
  const change = (fn: (doc: JuraCADDocument) => JuraCADDocument) =>
    set((s) => {
      const next = fn(s.history.present);
      // Keep sketches (and anything else) on Plane features where their planes are now.
      const settled = next === s.history.present ? next : refreshDocumentPlanes(next, resolveVariables(next.variables).values);
      return { history: commit(s.history, settled) };
    });
  /** A change to the features of the Part Studio on show. */
  const changeStudio = (fn: (doc: JuraCADDocument) => JuraCADDocument) =>
    change((doc) => inStudio(doc, activeStudioId(get()) ?? MAIN_STUDIO, fn));
  /** The document as the Part Studio on show sees it (its features in `features`). */
  const view = () => studioView(get().history.present, activeStudioId(get()) ?? MAIN_STUDIO);

  const initialDoc = loadSavedDocument();
  return {
    ...savedFileFor(initialDoc),
    history: historyOf(initialDoc),
    editing: null,
    sketch: null,
    selectedFeatureId: null,
    selection: [],
    section: null,
    printBed: null,
    hiddenParts: [],
    transparentParts: [],
    showFlat: false,
    selectedParts: [],
    selectedPlane: null,
    listHoverPlane: null,
    hiddenDatums: [],

    kernelStatus: "loading",
    kernelError: null,
    rebuildBusy: false,
    parts: [],
    featureErrors: {},
    sketchLinks: NO_LINKS,
    lastRebuildMs: null,

    dialog: null,
    toast: null,
    activeTab: null,
    asmSelection: [],
    hiddenInstances: [],
    mateDraft: null,
    dragPreview: null,
    animatingMate: null,
    setAnimatingMate: (animatingMate) => set({ animatingMate }),
    drawingTool: "select",
    selectedDim: null,
    selectedDims: NO_DIMS,
    rollbackTo: null,

    startCreate: (type) => {
      const s = get();
      if (type === "sketch") {
        // On the highlighted plane, or Plane feature, if any.
        const planeFeature = activeFeatures(s).find((f) => f.id === s.selectedFeatureId && f.type === "plane");
        const frame = planeFeature ? framesOf(activeFeatures(s)).get(planeFeature.id) : undefined;
        s.startSketch(planeFeature && frame ? planeAsSketchPlane(planeFeature, frame) : s.selectedPlane ? { kind: "default", name: s.selectedPlane } : null);
        return;
      }
      const draft = createFeature(view(), type);
      const features = activeFeatures(s);
      // Extrude or revolve the sketch that's highlighted in the list, if any.
      if (isSketchSolid(type)) {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (picked) {
          draft.sketchRef = picked.id;
          if (type === "revolve" && picked.sketch) draft.revolve = { axis: defaultAxis(picked.sketch.data), flip: false };
        }
      }
      // Transform the part that's selected in the 3D view (or the latest part).
      if (type === "transform" && draft.transform) {
        const mine = studioParts(s);
        const partId = s.selection[0]?.partId ?? mine[mine.length - 1]?.id;
        if (partId) draft.transform = { ...draft.transform, partId };
      }
      // A new plane starts offset from the standard plane selected in the list (or 3D view), if any.
      if (type === "plane" && draft.planeDef && s.selectedPlane) draft.planeDef = { ...draft.planeDef, ref: { kind: "default", name: s.selectedPlane } };
      // Split starts with the part picked in the Parts list (or clicked in the 3D view).
      if (type === "split" && draft.splitDef) {
        const partId = s.selectedParts[0] ?? s.selection[0]?.partId;
        if (partId) draft.splitDef = { ...draft.splitDef, partId, picking: "plane" };
        if (s.selectedPlane) draft.splitDef = { ...draft.splitDef, plane: { kind: "default", name: s.selectedPlane } };
      }
      // Face features start with the faces selected.
      if (type === "thicken" || type === "draft" || type === "moveFace" || type === "replaceFace" || type === "deleteFace" || type === "thread" || type === "fullRound" || type === "wrap" || type === "enclose" || type === "offsetSurface") {
        draft.picks = s.selection
          .filter((item) => item.kind === "face")
          .map((item) => pickFor(s.parts, item))
          .filter((p): p is TopoPick => p !== null);
      }
      // A flange (or Fill) starts with the edges selected.
      if (type === "flange" || type === "hem" || type === "cornerBreak" || type === "fill" || type === "extendSurface" || type === "ruled") {
        draft.picks = s.selection
          .filter((item) => item.kind === "edge")
          .map((item) => pickFor(s.parts, item))
          .filter((p): p is TopoPick => p !== null);
      }
      // A rib (or sheet metal) uses the sketch highlighted in the list, if any.
      if (type === "rib" || type === "sheetMetal" || type === "tab" || type === "bend" || type === "jog") {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (picked) draft.sketchRef = picked.id;
      }
      // Delete part starts with the parts picked in the Parts list.
      if (type === "deletePart") draft.deleteParts = [...s.selectedParts];
      // A Boolean starts with the parts picked in the Parts list.
      if (type === "boolean" && draft.booleanDef && s.selectedParts.length) draft.booleanDef = { ...draft.booleanDef, targets: [...s.selectedParts] };
      // A plane starts from the plane (or Plane feature) highlighted, if any.
      if (type === "plane" && draft.planeDef) {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "plane");
        const frame = picked ? framesOf(features).get(picked.id) : undefined;
        if (picked && frame) draft.planeDef = { ...draft.planeDef, ref: planeAsSketchPlane(picked, frame) };
        else if (s.selectedPlane) draft.planeDef = { ...draft.planeDef, ref: { kind: "default", name: s.selectedPlane } };
      }
      // A hole uses the sketch highlighted in the list, if any.
      if (type === "hole" && draft.hole) {
        const picked = features.find((f) => f.id === s.selectedFeatureId && f.type === "sketch");
        if (picked) draft.hole = { ...draft.hole, sketchRef: picked.id };
      }
      // Mirror and circular patterns start with no plane or axis: the dialog asks for one to be clicked
      // (Onshape does the same), rather than quietly using the origin.
      if (draft.mirror) draft.mirror = { ...draft.mirror, unset: true };
      if (type === "circularPattern" && draft.pattern) draft.pattern = { ...draft.pattern, unset: true };
      // Mirror and patterns start with the feature highlighted in the list, if it makes a solid.
      if (isPatternFeature(type)) {
        const picked = features.find((f) => f.id === s.selectedFeatureId && isSolidFeature(f.type));
        if (picked) {
          if (draft.mirror) draft.mirror = { ...draft.mirror, sources: [picked.id] };
          if (draft.pattern) draft.pattern = { ...draft.pattern, sources: [picked.id] };
        }
      }
      // Fillet, chamfer and shell start with whatever is selected (faces only, for shell).
      if (isPickFeature(type)) {
        draft.picks = s.selection
          .filter((item) => type !== "shell" || item.kind === "face")
          .map((item) => pickFor(s.parts, item))
          .filter((p): p is TopoPick => p !== null);
      }
      set({ editing: { mode: "create", draft }, sketch: null, selectedFeatureId: null, selection: [], selectedPlane: null, showFlat: false });
    },

    startImport: (file) => {
      const s = get();
      const draft = createFeature(view(), "import");
      draft.import = file;
      const base = importName(file.fileName);
      const used = new Set(activeFeatures(s).map((f) => f.name));
      let name = base;
      for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
      draft.name = name;
      set({ editing: { mode: "create", draft }, sketch: null, selectedFeatureId: null, selection: [], selectedPlane: null, showFlat: false });
    },

    startEdit: (id) => {
      const f = activeFeatures(get()).find((x) => x.id === id);
      if (!f) return;
      set({
        editing: { mode: "edit", draft: { ...f, params: { ...f.params } } },
        showFlat: false,
        sketch: f.type === "sketch" ? newSession() : null,
        selectedFeatureId: id,
        selectedPlane: null,
        selection: [],
      });
    },

    startSketch: (plane) => {
      const draft = createFeature(view(), "sketch");
      draft.sketch = { plane, data: draft.sketch!.data };
      set({
        editing: { mode: "create", draft },
        showFlat: false,
        sketch: {
          ...newSession(),
          message: plane ? null : { text: "Click Top, Front or Right in the feature list, or a flat face, to sketch on it.", tone: "info" },
        },
        selectedFeatureId: null,
        selectedPlane: null,
        selection: [],
      });
    },

    setSketchPlane: (plane) =>
      set((s) =>
        s.editing?.draft.sketch
          ? {
              editing: { ...s.editing, draft: { ...s.editing.draft, sketch: { ...s.editing.draft.sketch, plane } } },
              sketch: s.sketch ? { ...s.sketch, message: null } : s.sketch,
              selectedPlane: null,
              selection: [],
            }
          : {},
      ),

    repickSketchPlane: () =>
      set((s) =>
        s.editing?.draft.sketch && s.sketch
          ? {
              editing: { ...s.editing, draft: { ...s.editing.draft, sketch: { ...s.editing.draft.sketch, plane: null } } },
              sketch: { ...s.sketch, message: { text: "Click a flat face, or Top, Front or Right, to put the sketch on.", tone: "info" } },
            }
          : {},
      ),

    updateSketch: (next, opts = {}) =>
      set((s) => {
        if (!s.editing?.draft.sketch || !s.sketch) return {};
        const prev = s.editing.draft.sketch.data;
        // Texts and pictures stay, even through edits that only know about points, curves and constraints.
        const data = keepSketchExtras(prev, next);
        if (prev === data) return opts.selection ? { sketch: { ...s.sketch, selection: opts.selection } } : {};
        return {
          editing: { ...s.editing, draft: { ...s.editing.draft, sketch: { ...s.editing.draft.sketch, data } } },
          sketch: {
            ...s.sketch,
            past: opts.record === false ? s.sketch.past : [...s.sketch.past, prev].slice(-200),
            future: opts.record === false ? s.sketch.future : [],
            selection: opts.selection ?? s.sketch.selection.filter((id) => existsIn(data, id)),
          },
        };
      }),

    recordSketchStep: (before) =>
      set((s) => {
        if (!s.sketch || !s.editing?.draft.sketch || s.editing.draft.sketch.data === before) return {};
        return { sketch: { ...s.sketch, past: [...s.sketch.past, before].slice(-200), future: [] } };
      }),

    sketchUndo: () =>
      set((s) => {
        if (!s.sketch || !s.editing?.draft.sketch || s.sketch.past.length === 0) return {};
        const prev = s.sketch.past[s.sketch.past.length - 1];
        return {
          editing: { ...s.editing, draft: { ...s.editing.draft, sketch: { ...s.editing.draft.sketch, data: prev } } },
          sketch: {
            ...s.sketch,
            past: s.sketch.past.slice(0, -1),
            future: [s.editing.draft.sketch.data, ...s.sketch.future],
            selection: [],
            editingDimension: null,
          },
        };
      }),

    sketchRedo: () =>
      set((s) => {
        if (!s.sketch || !s.editing?.draft.sketch || s.sketch.future.length === 0) return {};
        const [next, ...rest] = s.sketch.future;
        return {
          editing: { ...s.editing, draft: { ...s.editing.draft, sketch: { ...s.editing.draft.sketch, data: next } } },
          sketch: { ...s.sketch, past: [...s.sketch.past, s.editing.draft.sketch.data], future: rest, selection: [], editingDimension: null },
        };
      }),

    setSketchTool: (tool) => {
      get().discardOfferedDimensions();
      set((s) => (s.sketch ? { sketch: { ...s.sketch, tool, message: null, editingDimension: null } } : {}));
    },
    setSketchSelection: (selection) => set((s) => (s.sketch ? { sketch: { ...s.sketch, selection } } : {})),
    setSketchMessage: (text, tone = "info") =>
      set((s) => (s.sketch ? { sketch: { ...s.sketch, message: text ? { text, tone } : null } } : {})),
    setSketchConstruction: (construction) => set((s) => (s.sketch ? { sketch: { ...s.sketch, construction } } : {})),
    setSketchOptions: (patch) => set((s) => (s.sketch ? { sketch: { ...s.sketch, ...patch } } : {})),
    setEditingDimension: (editingDimension) => set((s) => (s.sketch ? { sketch: { ...s.sketch, editingDimension } } : {})),
    offerDimensions: (ids) => set((s) => (s.sketch ? { sketch: { ...s.sketch, provisional: ids, editingDimension: ids[0] ?? null } } : {})),
    keepOfferedDimension: (id) =>
      set((s) => {
        if (!s.sketch) return {};
        const provisional = s.sketch.provisional.filter((x) => x !== id);
        return { sketch: { ...s.sketch, provisional, editingDimension: provisional[0] ?? null } };
      }),
    discardOfferedDimensions: () => {
      const s = get();
      const data = s.editing?.draft.sketch?.data;
      if (!s.sketch || !data || s.sketch.provisional.length === 0) return;
      const gone = s.sketch.provisional.filter((id) => data.constraints.some((c) => c.id === id));
      set({ sketch: { ...s.sketch, provisional: [], editingDimension: null } });
      if (gone.length) get().updateSketch(deleteItems(data, gone), { record: false });
    },

    setDraftParam: (key, value) =>
      set((s) =>
        s.editing ? { editing: { ...s.editing, draft: { ...s.editing.draft, params: { ...s.editing.draft.params, [key]: value } } } } : {},
      ),

    setDraftField: (patch) =>
      set((s) => (s.editing ? { editing: { ...s.editing, draft: { ...s.editing.draft, ...patch } } } : {})),

    toggleDraftPick: (pick) =>
      set((s) => {
        if (!s.editing) return {};
        const picks = s.editing.draft.picks ?? [];
        const i = picks.findIndex((p) => p.partId === pick.partId && sameRef(p.ref, pick.ref));
        const next = i >= 0 ? picks.filter((_, j) => j !== i) : [...picks, pick];
        return { editing: { ...s.editing, draft: { ...s.editing.draft, picks: next } } };
      }),

    toggleDraftSource: (featureId) =>
      set((s) => {
        if (!s.editing) return {};
        const d = s.editing.draft;
        const toggle = (list: string[]) => (list.includes(featureId) ? list.filter((x) => x !== featureId) : [...list, featureId]);
        if (d.mirror) return { editing: { ...s.editing, draft: { ...d, mirror: { ...d.mirror, sources: toggle(d.mirror.sources) } } } };
        if (d.pattern) return { editing: { ...s.editing, draft: { ...d, pattern: { ...d.pattern, sources: toggle(d.pattern.sources) } } } };
        return {};
      }),

    setDraftMirrorPlane: (plane) =>
      set((s) =>
        s.editing?.draft.mirror ? { editing: { ...s.editing, draft: { ...s.editing.draft, mirror: setMirrorReference(s.editing.draft.mirror, { kind: "plane", plane }) } } } : {},
      ),

    commitDraft: () => {
      // Dimensions offered but not kept aren't part of the sketch.
      get().discardOfferedDimensions();
      const { editing } = get();
      if (!editing) return false;
      if (editing.draft.type === "sketch" && !editing.draft.sketch?.plane) {
        get().setSketchMessage("Pick a plane or flat face to sketch on first.", "error");
        return false;
      }
      const { errors } = resolveParams(editing.draft);
      if (Object.keys(errors).length > 0) return false;
      const named = { ...editing.draft, name: editing.draft.name.trim() || "Unnamed feature" };
      // Part edges brought in just to snap to, that nothing uses any more, are tidied away.
      const sk = named.sketch;
      const draft = sk ? { ...named, sketch: { ...sk, data: withoutEmptyExtras(pruneReferences(sk.data)) } } : named;
      // Rolled back: a new feature goes in at the rollback point, and the bar moves down past it.
      const at = get().rollbackTo;
      changeStudio((doc) => (editing.mode === "create" ? (at ? insertFeatureAfter(doc, draft, at) : addFeature(doc, draft)) : replaceFeature(doc, draft)));
      set({ editing: null, sketch: null, selectedFeatureId: draft.id, ...(at && editing.mode === "create" ? { rollbackTo: draft.id } : {}) });
      return true;
    },

    cancelDraft: () => set({ editing: null, sketch: null }),

    setRollback: (id) => {
      if (get().editing) return;
      const last = view().features[view().features.length - 1];
      set({ rollbackTo: id && id !== last?.id ? id : null });
    },

    suppressThenFinish: (ids, commit) => {
      const { editing } = get();
      const off = (doc: JuraCADDocument) => ids.reduce((d, id) => setSuppressed(d, id, true), doc);
      if (commit && editing) {
        const draft = { ...editing.draft, name: editing.draft.name.trim() || "Unnamed feature" };
        changeStudio((doc) => {
          const d = off(doc);
          return editing.mode === "create" ? addFeature(d, draft) : replaceFeature(d, draft);
        });
        set({ editing: null, sketch: null, selectedFeatureId: draft.id });
        return;
      }
      changeStudio(off);
      set({ editing: null, sketch: null });
    },

    moveFeature: (id, beforeId) => {
      const r = moveFeatureIn(view().features, id, beforeId);
      if (typeof r === "string") {
        get().showToast(r, "info");
        return;
      }
      changeStudio((doc) => ({ ...doc, features: r }));
    },

    deleteFeature: (id) => {
      changeStudio((doc) => removeFeature(doc, id));
      set((s) => ({
        selectedFeatureId: s.selectedFeatureId === id ? null : s.selectedFeatureId,
        editing: s.editing?.draft.id === id ? null : s.editing,
        sketch: s.editing?.draft.id === id ? null : s.sketch,
      }));
    },

    toggleSuppressed: (id) => {
      const f = activeFeatures(get()).find((x) => x.id === id);
      if (f) changeStudio((doc) => setSuppressed(doc, id, !f.suppressed));
    },

    renameFeature: (id, name) => changeStudio((doc) => renameFeature(doc, id, name)),
    setFeatureFolder: (ids, folder) => changeStudio((doc) => setFolder(doc, ids, folder)),
    renameFeatureFolder: (from, to) => changeStudio((doc) => renameFolder(doc, from, to)),

    setPartProperties: (partId, props) => change((doc) => setPartPropertiesIn(doc, partId, props)),
    setPartMaterial: (partId, material) =>
      change((doc) => {
        const materials = { ...(doc.materials ?? {}) };
        if (material && material !== DEFAULT_MATERIAL) materials[partId] = material;
        else delete materials[partId];
        const { materials: _old, ...rest } = doc;
        return Object.keys(materials).length ? { ...rest, materials } : rest;
      }),

    setPartColour: (partId, colour) =>
      change((doc) => {
        const appearance = { ...(doc.appearance ?? {}) };
        if (colour) appearance[partId] = colour;
        else delete appearance[partId];
        const { appearance: _old, ...rest } = doc;
        return Object.keys(appearance).length ? { ...rest, appearance } : rest;
      }),

    setVariables: (variables) => change((doc) => applyVariables(doc, variables)),
    addConfiguration: (name) => change((doc) => addConfiguration(doc, name)),
    switchConfiguration: (id) => change((doc) => switchConfiguration(doc, id)),
    renameConfiguration: (id, name) => change((doc) => renameConfiguration(doc, id, name)),
    removeConfiguration: (id) => change((doc) => removeConfiguration(doc, id)),

    renamePart: (partId, name) => {
      const old = get().parts.find((p) => p.id === partId)?.name ?? "";
      if (name.trim() === old) return;
      change((doc) => renamePart(doc, partId, old, name));
    },

    renameDocument: (name) => {
      const trimmed = name.trim();
      if (trimmed && trimmed !== get().history.present.name) change((doc) => ({ ...doc, name: trimmed }));
    },

    newDocument: () => {
      set((s) => ({
        history: commit(s.history, emptyDocument()),
        editing: null,
        sketch: null,
        selectedFeatureId: null,
        selection: [],
        hiddenParts: [],
        transparentParts: [],
        selectedParts: [],
        activeTab: null,
        asmSelection: [],
        mateDraft: null,
        savedDoc: null,
        fileName: null,
      }));
      rememberFile(get().history.present, null);
    },

    openDocument: (doc, fileName) => {
      set((s) => ({
        history: commit(s.history, doc),
        editing: null,
        sketch: null,
        selectedFeatureId: null,
        selection: [],
        selectedPlane: null,
        hiddenParts: [],
        transparentParts: [],
        selectedParts: [],
        activeTab: null,
        asmSelection: [],
        mateDraft: null,
        fileName,
      }));
      set((s) => ({ savedDoc: s.history.present }));
      rememberFile(get().history.present, fileName);
    },

    applyClaudeChange: (doc, studio, label, replace) => {
      set((s) => {
        const history = commit(s.history, refreshDocumentPlanes(doc, resolveVariables(doc.variables).values));
        if (replace) {
          return { history, selectedFeatureId: null, selection: [], selectedPlane: null, hiddenParts: [], transparentParts: [], selectedParts: [], activeTab: null, asmSelection: [] };
        }
        // The user stays on their tab (Claude works on the Part Studio on show, so that's normally the one changed).
        const keep = (id: string | null) => (id && studioFeatures(history.present, studio).some((f) => f.id === id) ? id : null);
        return { history, selectedFeatureId: keep(s.selectedFeatureId), selection: [] };
      });
      get().showToast(label, "info");
    },

    markSaved: (fileName) => {
      set((s) => ({ savedDoc: s.history.present, fileName }));
      rememberFile(get().history.present, fileName);
    },

    addAssembly: () => {
      const before = new Set((get().history.present.assemblies ?? []).map((a) => a.id));
      change((doc) => addAssembly(doc));
      const added = (get().history.present.assemblies ?? []).find((a) => !before.has(a.id));
      if (added) set({ activeTab: added.id, asmSelection: [], selection: [], selectedPlane: null, editing: null, sketch: null });
    },

    setActiveTab: (activeTab) => {
      if (get().editing) return;
      set({ activeTab, rollbackTo: null, animatingMate: null, asmSelection: [], selection: [], selectedParts: [], selectedPlane: null, selectedFeatureId: null, section: null, mateDraft: null, editingPattern: null, drawingTool: "select", selectedDim: null, selectedDims: NO_DIMS });
    },

    removeAssembly: (id) => {
      const s = get();
      const all = s.history.present.assemblies ?? [];
      const name = all.find((a) => a.id === id)?.name ?? "The assembly";
      const users = whereUsed(all, id).filter((a) => a.id !== id);
      change((doc) => removeAssembly(doc, id));
      if (users.length) s.showToast(`${name} was also taken out of ${users.map((a) => a.name).join(", ")}. Undo brings it all back.`, "info");
      if (get().activeTab === id) set({ activeTab: null, asmSelection: [] });
    },

    renameAssembly: (id, name) => change((doc) => renameAssembly(doc, id, name)),

    addPartStudio: () => {
      if (get().editing) return;
      const id = newId("s");
      change((doc) => addStudio(doc, id));
      set({ activeTab: id, asmSelection: [], selection: [], selectedPlane: null, selectedFeatureId: null, section: null, mateDraft: null, editingPattern: null });
    },

    renamePartStudio: (id, name) => change((doc) => renameStudio(doc, id, name)),

    addDrawing: () => {
      const s = get();
      if (s.editing) return;
      // Draw the part that's selected, else the last part of the Part Studio on show, else any part.
      const shown = studioParts(s);
      const partId = s.selection[0]?.partId ?? shown[shown.length - 1]?.id ?? s.parts[s.parts.length - 1]?.id;
      const asm = activeAssembly(s);
      const source = asm ? { kind: "assembly" as const, id: asm.id } : partId ? { kind: "part" as const, id: partId } : null;
      const id = newId("d");
      change((doc) => addDrawingTo(doc, id, source));
      set({ activeTab: id, asmSelection: [], selection: [], selectedPlane: null, selectedFeatureId: null, section: null, mateDraft: null, editingPattern: null, dialog: null });
    },

    changeDrawing: (fn) => {
      const d = activeDrawing(get());
      if (d) change((doc) => updateDrawing(doc, d.id, fn));
    },

    renameDrawing: (id, name) => change((doc) => renameDrawingIn(doc, id, name)),

    removeDrawing: (id) => {
      change((doc) => removeDrawingFrom(doc, id));
      if (get().activeTab === id) set({ activeTab: null });
    },

    removePartStudio: (id) => {
      if (get().editing) return;
      change((doc) => removeStudio(doc, id));
      if (get().activeTab === id) set({ activeTab: null, selection: [], selectedFeatureId: null });
    },

    insertInstance: (part, placement) => {
      const tab = get().activeTab;
      if (!tab) return;
      const before = new Set(activeAssembly(get())?.instances.map((i) => i.id) ?? []);
      change((doc) => insertInstance(doc, tab, part, placement));
      const added = activeAssembly(get())?.instances.find((i) => !before.has(i.id));
      if (added) set({ asmSelection: [added.id] });
    },

    insertSubAssembly: (assemblyId, placement) => {
      const s = get();
      const tab = s.activeTab;
      if (!tab) return;
      const problem = insertProblem(s.history.present, tab, assemblyId);
      if (problem) return s.showToast(problem, "error");
      const before = new Set(activeAssembly(s)?.instances.map((i) => i.id) ?? []);
      change((doc) => insertSubAssembly(doc, tab, assemblyId, placement));
      const added = activeAssembly(get())?.instances.find((i) => !before.has(i.id));
      if (added) set({ asmSelection: [added.id] });
    },

    updateInstance: (id, patch) => {
      const tab = get().activeTab;
      if (tab) change((doc) => updateInstance(doc, tab, id, patch));
    },

    removeInstances: (ids) => {
      const tab = get().activeTab;
      if (!tab || ids.length === 0) return;
      change((doc) => removeInstances(doc, tab, ids));
      set((s) => ({ asmSelection: s.asmSelection.filter((x) => !ids.includes(x)) }));
    },

    setAsmSelection: (asmSelection) => set({ asmSelection }),

    startMate: (type) => {
      const asm = activeAssembly(get());
      if (!asm) return;
      const values: Record<string, string> = {};
      for (const d of MATE_TYPES[type].values) values[d.key] = "0";
      set({
        mateDraft: { mode: "create", mate: { id: newId("m"), name: nextMateName(asm, type), type, flip: false, values } },
        asmSelection: [],
        dialog: null,
      });
    },

    editMate: (id) => {
      const mate = activeAssembly(get())?.mates?.find((m) => m.id === id);
      if (mate) set({ mateDraft: { mode: "edit", mate: { ...mate, values: { ...mate.values } } }, asmSelection: [], dialog: null });
    },

    setMateDraft: (patch) =>
      set((s) => {
        if (!s.mateDraft) return {};
        const mate = { ...s.mateDraft.mate, ...patch };
        // A new kind of mate keeps the amounts it shares with the old one, and starts the rest at 0.
        if (patch.type && patch.type !== s.mateDraft.mate.type) {
          const values: Record<string, string> = {};
          for (const d of MATE_TYPES[patch.type].values) values[d.key] = s.mateDraft.mate.values[d.key] ?? "0";
          mate.values = values;
          const asm = activeAssembly(s);
          const autoName = /^\S+ \d+$/.test(s.mateDraft.mate.name) && s.mateDraft.mode === "create";
          if (asm && autoName) mate.name = nextMateName(asm, patch.type);
          // Only Width mates use a second face on each part.
          if (patch.type !== "width") {
            const one = (c?: MateConnector) => (c?.pick2 ? { instanceId: c.instanceId, ...(c.path ? { path: c.path } : {}), pick: c.pick } : c);
            mate.a = one(mate.a);
            mate.b = one(mate.b);
          }
        }
        return { mateDraft: { ...s.mateDraft, mate } };
      }),

    pickMateConnector: (c) => {
      const s = get();
      if (!s.mateDraft) return;
      // Two parts inside the same sub-assembly copy: it moves as one piece, so keep the first pick and say why.
      if (samePieceClick(s.mateDraft.mate, c)) {
        const top = activeAssembly(s)?.instances.find((i) => i.id === c.instanceId);
        const sub = s.history.present.assemblies?.find((a) => a.id === top?.subAssembly);
        s.showToast(`Both faces are in ${top?.name ?? "the same sub-assembly"}, which moves as one piece. Open ${sub?.name ?? "it"} (double-click it) to mate its parts to each other.`, "info");
        return;
      }
      set((st) => {
        if (!st.mateDraft) return {};
        const m = st.mateDraft.mate;
        const next: MateDraft = { ...m, ...pickConnector(m, c) };
        return { mateDraft: { ...st.mateDraft, mate: next } };
      });
    },

    commitMateDraft: () => {
      const s = get();
      const asm = activeAssembly(s);
      const d = s.mateDraft;
      if (!asm || !d || !d.mate.a || !d.mate.b) return false;
      const mate: Mate = { ...d.mate, a: d.mate.a, b: d.mate.b, name: d.mate.name.trim() || MATE_TYPES[d.mate.type].label };
      change((doc) => {
        const withMate = putMate(doc, asm.id, mate);
        const solvedAsm = withMate.assemblies?.find((a) => a.id === asm.id);
        return solvedAsm ? settleSolved(withMate, asm.id, solveWithParts(solvedAsm, s.parts, { hold: [mate.id], assemblies: s.history.present.assemblies })) : withMate;
      });
      set({ mateDraft: null });
      return true;
    },

    cancelMateDraft: () => set({ mateDraft: null }),

    setDragPreview: (dragPreview) => set({ dragPreview }),
    setDrawingTool: (drawingTool) => set({ drawingTool, selectedDim: null, selectedDims: NO_DIMS }),
    selectDim: (selectedDim) => set({ selectedDim, selectedDims: selectedDim ? [selectedDim] : NO_DIMS }),
    selectDims: (ids) => set({ selectedDim: ids.length === 1 ? ids[0] : null, selectedDims: ids.length ? ids : NO_DIMS }),

    commitDrag: () => {
      const s = get();
      const asm = activeAssembly(s);
      const d = s.dragPreview;
      set({ dragPreview: null });
      if (!asm || !d) return;
      if (d.kind === "instance") {
        change((doc) => updateInstance(doc, asm.id, d.id, { placement: d.placement }));
        return;
      }
      const mate = asm.mates?.find((m) => m.id === d.id);
      if (!mate) return;
      const moved = withDragChange(asm, d);
      const solved = solveWithParts(moved, s.parts, { hold: [mate.id], assemblies: s.history.present.assemblies });
      change((doc) => settleSolved(putMate(doc, asm.id, { ...mate, values: d.values }), asm.id, solved));
    },

    deleteMate: (id) => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      // Parts stay where the mates had put them.
      change((doc) => removeMate(settleSolved(doc, asm.id, solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies })), asm.id, id));
      if (s.mateDraft?.mate.id === id) set({ mateDraft: null });
    },

    theme: "light",
    setTheme: (theme) => set({ theme }),
    setUnits: (unit) =>
      change((doc) => {
        const { units: _old, ...rest } = doc;
        return unit === "in" ? { ...rest, units: "in" } : rest;
      }),
    savePosition: (name) => {
      const asm = activeAssembly(get());
      // Saved as shown: with the amounts loops of mates have moved to.
      if (asm) change((doc) => savePosition(settleSolved(doc, asm.id, solveWithParts(asm, get().parts, { assemblies: get().history.present.assemblies })), asm.id, newId("np"), name));
    },
    applyPosition: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => applyPosition(doc, asm.id, id));
    },
    removePosition: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => removePosition(doc, asm.id, id));
    },
    putRelation: (relation) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => putRelation(doc, asm.id, relation));
    },
    removeRelation: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => removeRelation(doc, asm.id, id));
    },
    setExplode: (amount) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => setExplode(doc, asm.id, amount));
      set({ explodePreview: null });
    },
    explodePreview: null,
    setExplodePreview: (amount) => set({ explodePreview: amount }),
    editingPattern: null,
    setEditingPattern: (editingPattern) => set({ editingPattern, ...(editingPattern ? { asmSelection: [], mateDraft: null, dialog: null } : {}) }),
    createPattern: (kind) => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      const seeds = asm.instances.filter((i) => s.asmSelection.includes(i.id) && !i.copyOf);
      if (!seeds.length) return;
      // Spaced a little more than the first part (or sub-assembly) is wide, so the copies don't overlap.
      const box = ownBox(asm, seeds[0], s.parts, s.history.present.assemblies ?? [], (p) => boundsOfVertices(p.vertices));
      const width = box ? box.max[0] - box.min[0] : 10;
      const pattern: AssemblyPattern =
        kind === "mirror"
          ? // Across the Right plane, moved out past the parts so the copies don't land on them.
            { id: newId("pt"), name: nextPatternName(asm, "Mirror"), kind: "mirror", seeds: seeds.map((i) => i.id), count: 2, amount: "0", axis: "x", centre: [Math.ceil((box ? box.max[0] : 0) + Math.max(...seeds.map((i) => i.placement.position[0])) + 5), 0, 0] }
          : {
              id: newId("pt"),
              name: nextPatternName(asm),
              kind: "linear",
              seeds: seeds.map((i) => i.id),
              count: 3,
              amount: String(Math.ceil(width + 5)),
              axis: "x",
            };
      change((doc) => updateAssembly(doc, asm.id, (a) => syncPattern(a, pattern, () => newId("i"))));
      set({ editingPattern: pattern.id, asmSelection: [] });
    },
    updatePattern: (id, patch) => {
      const asm = activeAssembly(get());
      const p = asm?.patterns?.find((x) => x.id === id);
      if (!asm || !p) return;
      const next: AssemblyPattern = { ...p, ...patch, name: (patch.name ?? p.name).trim() || p.name };
      change((doc) => updateAssembly(doc, asm.id, (a) => syncPattern(a, next, () => newId("i"))));
    },
    createReplicate: () => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm || s.asmSelection.length !== 1) return s.showToast("Select one part — one that's mated into a hole.", "info");
      const source = replicateSource(asm, s.asmSelection[0]);
      if (typeof source === "string") return s.showToast(source, "info");
      const rep: Replicate = { id: newId("rp"), name: nextReplicateName(asm), seed: s.asmSelection[0], mate: source.mate.id };
      const holes = replicateHoles(asm, rep, s.parts, s.history.present.assemblies);
      if (!holes.length) return s.showToast("No other holes like that one were found on the part it's mated to.", "info");
      change((doc) => {
        const next = updateAssembly(doc, asm.id, (a) => syncReplicate(a, rep, holes, () => newId("i")));
        const solved = next.assemblies?.find((a) => a.id === asm.id);
        return solved ? settlePlacements(next, asm.id, solveWithParts(solved, s.parts, { assemblies: s.history.present.assemblies }).placements) : next;
      });
      set({ asmSelection: [] });
      s.showToast(`Copied into ${holes.length} more hole${holes.length === 1 ? "" : "s"}.`, "success");
    },
    refreshReplicate: (id) => {
      const s = get();
      const asm = activeAssembly(s);
      const rep = asm?.replicates?.find((r) => r.id === id);
      if (!asm || !rep) return;
      const holes = replicateHoles(asm, rep, s.parts, s.history.present.assemblies);
      change((doc) => {
        const next = updateAssembly(doc, asm.id, (a) => syncReplicate(a, rep, holes, () => newId("i")));
        const solved = next.assemblies?.find((a) => a.id === asm.id);
        return solved ? settlePlacements(next, asm.id, solveWithParts(solved, s.parts, { assemblies: s.history.present.assemblies }).placements) : next;
      });
      s.showToast(`${rep.name}: ${holes.length} cop${holes.length === 1 ? "y" : "ies"}.`, "success");
    },
    deleteReplicate: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => updateAssembly(doc, asm.id, (a) => removeReplicate(a, id)));
    },
    duplicateInstances: () => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      const ids = asm.instances.filter((i) => s.asmSelection.includes(i.id)).map((i) => i.id);
      if (!ids.length) return;
      const { placements } = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
      // Beside everything already there (in +X), keeping the copies' places relative to each other.
      const boxOf = (i: Instance) => {
        // (A mirrored part is flipped across its own YZ plane before it's placed; a sub-assembly's box holds all its parts.)
        const b = ownBox(asm, i, s.parts, s.history.present.assemblies ?? [], (p) => boundsOfVertices(p.vertices));
        return b ? placedBox(b, placements[i.id] ?? i.placement) : null;
      };
      const all = asm.instances.map(boxOf).filter((b): b is Box3 => !!b);
      const mine = asm.instances.filter((i) => ids.includes(i.id)).map(boxOf).filter((b): b is Box3 => !!b);
      const shift: [number, number, number] = all.length && mine.length ? [Math.max(...all.map((b) => b.max[0])) + 10 - Math.min(...mine.map((b) => b.min[0])), 0, 0] : [20, 0, 0];
      const made = duplicateInstances(asm, ids, placements, shift, newId);
      change((doc) => updateAssembly(doc, asm.id, () => made.assembly));
      set({ asmSelection: made.ids });
    },
    replaceInstancePart: (instanceId, partId) => {
      const s = get();
      const asm = activeAssembly(s);
      const part = s.parts.find((p) => p.id === partId);
      const old = asm?.instances.find((i) => i.id === instanceId);
      if (!asm || !part || !old) return;
      const oldName = s.parts.find((p) => p.id === old.partId)?.name;
      change((doc) => {
        const next = updateAssembly(doc, asm.id, (a) => replaceInstancePart(a, instanceId, { id: part.id, name: part.name }, oldName));
        const solved = next.assemblies?.find((a) => a.id === asm.id);
        return solved ? settlePlacements(next, asm.id, solveWithParts(solved, s.parts, { assemblies: s.history.present.assemblies }).placements) : next;
      });
    },
    addExplodeStep: () => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      const ids = asm.instances.filter((i) => s.asmSelection.includes(i.id)).map((i) => i.id);
      if (!ids.length) return s.showToast("Select the parts to move first (click them, or Shift-click for more).", "info");
      change((doc) => updateAssembly(doc, asm.id, (a) => putExplodeStep(a, { id: newId("xs"), instances: ids, axis: "z", distance: storeLength(lengthUnit() === "in" ? "1" : "30") })));
      set({ asmSelection: [] });
    },
    updateExplodeStep: (id, patch) => {
      const asm = activeAssembly(get());
      const step = asm?.explodeSteps?.find((x) => x.id === id);
      if (!asm || !step) return;
      const next: ExplodeStep = { ...step, ...patch };
      if (!next.flip) delete next.flip;
      change((doc) => updateAssembly(doc, asm.id, (a) => putExplodeStep(a, next)));
    },
    removeExplodeStep: (id) => {
      const asm = activeAssembly(get());
      if (asm) change((doc) => updateAssembly(doc, asm.id, (a) => removeExplodeStep(a, id)));
    },
    deletePattern: (id) => {
      const asm = activeAssembly(get());
      if (!asm) return;
      change((doc) => updateAssembly(doc, asm.id, (a) => removePattern(a, id)));
      if (get().editingPattern === id) set({ editingPattern: null });
    },
    createGroup: () => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      const { placements } = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
      const made = makeGroup(asm, s.asmSelection, placements, newId("g"));
      if (made.error) {
        s.showToast(made.error);
        return;
      }
      change((doc) => updateAssembly(settlePlacements(doc, asm.id, placements), asm.id, (a) => ({ ...a, groups: made.assembly.groups })));
      set({ asmSelection: [] });
    },
    deleteGroup: (id) => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm) return;
      const { placements } = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
      change((doc) => updateAssembly(settlePlacements(doc, asm.id, placements), asm.id, (a) => removeGroup(a, id)));
    },
    renameGroup: (id, name) => {
      const asm = activeAssembly(get());
      if (!asm) return;
      change((doc) => updateAssembly(doc, asm.id, (a) => renameGroup(a, id, name)));
    },
    toggleMateSuppressed: (id) => {
      const s = get();
      const asm = activeAssembly(s);
      const mate = asm?.mates?.find((m) => m.id === id);
      if (!asm || !mate) return;
      const solved = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
      change((doc) => {
        const settled = settleSolved(doc, asm.id, solved);
        const kept = settled.assemblies?.find((a) => a.id === asm.id)?.mates?.find((m) => m.id === id) ?? mate;
        return putMate(settled, asm.id, { ...kept, suppressed: !mate.suppressed });
      });
    },
    setInstancesSuppressed: (ids, suppressed) => {
      const s = get();
      const asm = activeAssembly(s);
      if (!asm || !ids.length) return;
      // Everything stays where the mates put it now, so nothing jumps when a mate stops (or starts) counting.
      const solved = solveWithParts(asm, s.parts, { assemblies: s.history.present.assemblies });
      change((doc) => updateAssembly(settleSolved(doc, asm.id, solved), asm.id, (a) => setInstancesOff(a, ids, suppressed)));
      if (suppressed) set((st) => ({ asmSelection: st.asmSelection.filter((x) => !ids.includes(x)) }));
    },
    toggleInstanceHidden: (id) =>
      set((s) => ({ hiddenInstances: s.hiddenInstances.includes(id) ? s.hiddenInstances.filter((x) => x !== id) : [...s.hiddenInstances, id] })),

    // Undo/redo only when no feature dialog is open (see App shortcuts).
    undo: () => set((s) => (s.editing || s.mateDraft ? {} : { history: undoHistory(s.history), selection: [] })),
    // (While sketching, Ctrl+Z goes to sketchUndo instead — see App shortcuts.)
    redo: () => set((s) => (s.editing || s.mateDraft ? {} : { history: redoHistory(s.history), selection: [] })),

    // Picking a feature or picking parts: one at a time (the other side is then shown as "linked").
    selectFeature: (id) => set((s) => ({ selectedFeatureId: id, selectedPlane: id ? null : s.selectedPlane, selectedParts: id ? [] : s.selectedParts })),
    setSelection: (items) =>
      set((s) => ({ selection: items, selectedPlane: items.length > 0 ? null : s.selectedPlane })),
    mergeParts: (ids) => {
      const s = get();
      if (s.editing) return;
      const names = ids.map((id) => s.parts.find((p) => p.id === id)?.name).filter((n): n is string => !!n);
      if (names.length < 2) {
        s.showToast("Select two or more parts to merge.", "info");
        return;
      }
      const draft = createFeature(view(), "boolean");
      draft.name = `Merge ${names.length} parts`;
      draft.booleanDef = { op: "union", targets: [...ids], tools: [], keepTools: false, picking: "targets" };
      changeStudio((d) => addFeature(d, draft));
      set({ selectedParts: [ids[0]], selectedFeatureId: null });
      s.showToast(`Merged ${names.join(", ")} into one part. Undo to separate them again.`, "success");
    },
    duplicateParts: (ids) => {
      const s = get();
      if (s.editing || ids.length === 0) return;
      const drafts = ids.flatMap((partId) => {
        const part = s.parts.find((p) => p.id === partId);
        if (!part) return [];
        const box = boundsOfVertices(part.vertices);
        const width = box ? box.max[0] - box.min[0] : 20;
        const draft = createFeature(view(), "transform");
        draft.name = `Copy of ${part.name}`;
        draft.transform = { axis: "z", about: "centre", copy: true, partId };
        draft.params = { ...draft.params, dx: startingLength(width + 10) };
        return [draft];
      });
      if (drafts.length === 1) {
        set({ editing: { mode: "create", draft: drafts[0] }, sketch: null, selectedFeatureId: null, selection: [], selectedParts: [], selectedPlane: null });
        return;
      }
      // Several: add them one after another.
      const added: Feature[] = drafts;
      changeStudio((d) => added.reduce((acc, f) => addFeature(acc, f), d));
      set({ selectedParts: [] });
      s.showToast(`Copied ${added.length} parts — each copy is a Move/copy feature you can edit.`, "success");
    },
    toggleBooleanPart: (partId) =>
      set((s) => {
        const d = s.editing?.draft;
        const b = d?.booleanDef;
        if (!s.editing || !d || !b) return {};
        const key = b.op === "subtract" && b.picking === "tools" ? "tools" : "targets";
        const other = key === "tools" ? "targets" : "tools";
        const list = b[key].includes(partId) ? b[key].filter((x) => x !== partId) : [...b[key], partId];
        const booleanDef = { ...b, [key]: list, [other]: b[other].filter((x) => x !== partId) };
        return { editing: { ...s.editing, draft: { ...d, booleanDef } } };
      }),
    setSelectedParts: (selectedParts) => set((s) => ({ selectedParts, selectedFeatureId: selectedParts.length ? null : s.selectedFeatureId })),
    setPartsTransparent: (ids, on) =>
      set((s) => ({ transparentParts: on ? [...s.transparentParts.filter((p) => !ids.includes(p)), ...ids] : s.transparentParts.filter((p) => !ids.includes(p)) })),
    setPartsHidden: (ids, hidden) =>
      set((s) => ({ hiddenParts: hidden ? [...s.hiddenParts.filter((p) => !ids.includes(p)), ...ids] : s.hiddenParts.filter((p) => !ids.includes(p)) })),
    setShowFlat: (showFlat) => set({ showFlat, selection: [] }),
    toggleHidden: (partId) =>
      set((s) => ({
        hiddenParts: s.hiddenParts.includes(partId) ? s.hiddenParts.filter((p) => p !== partId) : [...s.hiddenParts, partId],
      })),

    selectPlane: (plane) =>
      set((s) => ({
        selectedPlane: plane,
        selection: plane ? [] : s.selection,
        selectedFeatureId: plane ? null : s.selectedFeatureId,
      })),
    setListHoverPlane: (listHoverPlane) => set({ listHoverPlane }),
    toggleDatum: (datum) =>
      set((s) => {
        const hidden = s.hiddenDatums.includes(datum);
        return {
          hiddenDatums: hidden ? s.hiddenDatums.filter((d) => d !== datum) : [...s.hiddenDatums, datum],
          // A hidden plane can't stay selected.
          selectedPlane: !hidden && s.selectedPlane === datum ? null : s.selectedPlane,
        };
      }),

    openDialog: (dialog) => set({ dialog }),
    setSection: (section) => set({ section }),
    setPrintBed: (printBed) => set({ printBed }),

    showToast: (text, tone = "info") => set({ toast: { id: ++toastCounter, text, tone } }),

    setKernelStatus: (kernelStatus, error) => set({ kernelStatus, kernelError: error ?? null }),
    setRebuildBusy: (rebuildBusy) => set({ rebuildBusy }),
    setRebuildResult: (built, featureErrors, ms, rebuilt, studioOrder, sketchLinks) =>
      set((s) => {
        // The sketch open for editing follows its part's face and edges, as the engine found them.
        const links = sketchLinks && Object.keys(sketchLinks).length ? sketchLinks : NO_LINKS;
        const draft = s.editing?.draft;
        const info = draft?.sketch ? links[draft.id] : undefined;
        let editing = s.editing;
        if (editing && draft?.sketch && info) {
          const data = followLinks(draft.sketch.data, info.links);
          const plane = info.plane && draft.sketch.plane?.kind === "face" && !samePlace(info.plane, draft.sketch.plane) ? info.plane : draft.sketch.plane;
          if (data !== draft.sketch.data || plane !== draft.sketch.plane) editing = { ...editing, draft: { ...draft, sketch: { plane, data } } };
        }
        // Part Studios that weren't rebuilt keep the parts they had.
        let parts = built;
        if (rebuilt && studioOrder) {
          parts = [];
          for (const id of studioOrder) {
            if (rebuilt.includes(id)) parts.push(...built.filter((p) => (p.studioId ?? MAIN_STUDIO) === id));
            else parts.push(...s.parts.filter((p) => (p.studioId ?? MAIN_STUDIO) === id));
          }
        }
        const ids = new Set(parts.map((p) => p.id));
        return {
          parts,
          featureErrors,
          sketchLinks: links,
          ...(editing !== s.editing ? { editing } : {}),
          lastRebuildMs: ms,
          rebuildBusy: false,
          // Drop picks and hidden flags for parts that no longer exist.
          selection: s.selection.filter((x) => ids.has(x.partId)),
          hiddenParts: s.hiddenParts.filter((p) => ids.has(p)),
          transparentParts: s.transparentParts.filter((p) => ids.has(p)),
          selectedParts: s.selectedParts.filter((p) => ids.has(p)),
        };
      }),
  };
});

/** The assembly on show, or null when the Part Studio is on show (or the assembly was undone away). */
export function activeAssembly(s: Pick<AppState, "activeTab" | "history">): Assembly | null {
  if (!s.activeTab) return null;
  return s.history.present.assemblies?.find((a) => a.id === s.activeTab) ?? null;
}

/**
 * The Part Studio on show (its id), or null when an assembly is on show.
 * Falls back to the first Part Studio if the tab's studio was undone away.
 */
export function activeStudioId(s: Pick<AppState, "activeTab" | "history">): string | null {
  const doc = s.history.present;
  if (s.activeTab && doc.assemblies?.some((a) => a.id === s.activeTab)) return null;
  if (s.activeTab && doc.drawings?.some((d) => d.id === s.activeTab)) return null;
  return s.activeTab && studioExists(doc, s.activeTab) ? s.activeTab : MAIN_STUDIO;
}

/** Features of the Part Studio on show (the first one while an assembly is on show). Same array each time. */
export function activeFeatures(s: Pick<AppState, "activeTab" | "history">): Feature[] {
  return studioFeatures(s.history.present, activeStudioId(s) ?? MAIN_STUDIO);
}

const studioPartsCache = new WeakMap<PartMesh[], Map<string, PartMesh[]>>();
/** The parts made by one Part Studio (the same array each time for the same parts list, so safe in selectors). */
export function partsInStudio(parts: PartMesh[], studioId: string): PartMesh[] {
  let byStudio = studioPartsCache.get(parts);
  if (!byStudio) {
    byStudio = new Map();
    studioPartsCache.set(parts, byStudio);
  }
  let list = byStudio.get(studioId);
  if (!list) {
    list = parts.filter((p) => (p.studioId ?? MAIN_STUDIO) === studioId);
    byStudio.set(studioId, list);
  }
  return list;
}

/** Parts of the Part Studio on show (none while an assembly is on show). */
export function studioParts(s: Pick<AppState, "activeTab" | "history" | "parts">): PartMesh[] {
  const id = activeStudioId(s);
  return id ? partsInStudio(s.parts, id) : NO_PARTS;
}
const NO_PARTS: PartMesh[] = [];

/** The drawing on show, or null. */
export function activeDrawing(s: Pick<AppState, "activeTab" | "history">): Drawing | null {
  if (!s.activeTab) return null;
  return s.history.present.drawings?.find((d) => d.id === s.activeTab) ?? null;
}

/** The current document (without any unsaved draft). */
export const useDocument = () => useStore((s) => s.history.present);

// Keep the maths boxes' variable values in step with the document (including after undo/redo).
let scopeFor: Variable[] | undefined | null = null;
/** The document's units, for components that show lengths (re-renders them when it changes). */
export const useLengthUnit = (): LengthUnit => useStore((s) => (s.history.present.units === "in" ? "in" : "mm"));
useStore.subscribe((s) => setLengthUnit(s.history.present.units === "in" ? "in" : "mm"));

function syncScope(variables: Variable[] | undefined) {
  if (variables === scopeFor) return;
  scopeFor = variables;
  setCurrentScope(resolveVariables(variables).values);
}
syncScope(useStore.getState().history.present.variables);
useStore.subscribe((s) => syncScope(s.history.present.variables));

/** The holes a replicate's copies go in: every hole like the original's on the part it's mated to (as built now). */
function replicateHoles(a: Assembly, rep: Replicate, parts: PartMesh[], assemblies: readonly Assembly[] = []) {
  const mate = a.mates?.find((m) => m.id === rep.mate);
  if (!mate) return [];
  const target = mate.a.instanceId === rep.seed ? mate.b : mate.a;
  // (The holes may be in a part inside a sub-assembly.)
  const instance = instanceAt(a, assemblies, leafKey(target.instanceId, target.path))?.part;
  const part = instance && findMesh(parts, meshIdOf(instance));
  // Picks name the part itself, whichever configuration it's shown in.
  return part && instance ? matchingConnectors(part, { ...target.pick, partId: part.id }).map((p) => ({ ...p, partId: instance.partId })) : [];
}

