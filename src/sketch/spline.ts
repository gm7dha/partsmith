/**
 * Splines: smooth curves through the points the user clicks (Onshape's
 * spline). Each stretch between two points is a cubic Bézier curve shaped so
 * the curve flows smoothly through every point (a Catmull-Rom spline); a
 * closed spline joins back to its first point.
 */
type P2 = [number, number];

/**
 * A conic (Onshape's conic): from `a` to `b`, pulled towards the corner point
 * `apex` by `rho` — 0.5 is a parabola, less is flatter (an ellipse's arc),
 * more is fuller (a hyperbola's). It's a rational quadratic Bézier curve with
 * weight rho / (1 − rho) on the corner, given here as cubic pieces that follow
 * it to well within a thousandth of a millimetre.
 */
export function conicBeziers(a: P2, apex: P2, b: P2, rho: number, pieces = 8): [P2, P2, P2, P2][] {
  const r = Math.min(0.99, Math.max(0.01, rho));
  const w = r / (1 - r);
  const at = (t: number): { p: P2; d: P2 } => {
    const u = 1 - t;
    const k0 = u * u;
    const k1 = 2 * w * u * t;
    const k2 = t * t;
    const D = k0 + k1 + k2;
    const N: P2 = [k0 * a[0] + k1 * apex[0] + k2 * b[0], k0 * a[1] + k1 * apex[1] + k2 * b[1]];
    const d0 = -2 * u;
    const d1 = 2 * w * (1 - 2 * t);
    const d2 = 2 * t;
    const dD = d0 + d1 + d2;
    const dN: P2 = [d0 * a[0] + d1 * apex[0] + d2 * b[0], d0 * a[1] + d1 * apex[1] + d2 * b[1]];
    return { p: [N[0] / D, N[1] / D], d: [(dN[0] * D - N[0] * dD) / (D * D), (dN[1] * D - N[1] * dD) / (D * D)] };
  };
  const out: [P2, P2, P2, P2][] = [];
  for (let i = 0; i < pieces; i++) {
    const t0 = i / pieces;
    const t1 = (i + 1) / pieces;
    const s = at(t0);
    const e = at(t1);
    const h = (t1 - t0) / 3;
    out.push([s.p, [s.p[0] + s.d[0] * h, s.p[1] + s.d[1] * h], [e.p[0] - e.d[0] * h, e.p[1] - e.d[1] * h], e.p]);
  }
  // Exactly through the end points.
  out[0][0] = a;
  out[out.length - 1][3] = b;
  return out;
}

/**
 * The curve's direction and speed at each point (its tangent vector): the
 * one the user set by dragging a handle, or else the natural one — half the
 * way from the point before to the point after (so the curve flows smoothly),
 * straight on at an open spline's ends.
 */
export function splineTangents(pts: P2[], closed: boolean, set?: (P2 | undefined)[]): P2[] {
  const n = pts.length;
  const at = (i: number): P2 => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[i];
  };
  return pts.map((_, i) => set?.[i] ?? [(at(i + 1)[0] - at(i - 1)[0]) / 2, (at(i + 1)[1] - at(i - 1)[1]) / 2]);
}

/**
 * The Bézier pieces (start, two handles, end) for a spline through `pts` — or,
 * given `conic`, a conic over its three points. `tangents` are the user's
 * handles (per point; missing ones curve naturally).
 */
export function splineBeziers(pts: P2[], closed: boolean, conic?: number, tangents?: (P2 | undefined)[], tangentsIn?: (P2 | undefined)[]): [P2, P2, P2, P2][] {
  if (conic !== undefined && pts.length === 3) return conicBeziers(pts[0], pts[1], pts[2], conic);
  const n = pts.length;
  if (n < 2) return [];
  const t = splineTangents(pts, closed, tangents);
  const out: [P2, P2, P2, P2][] = [];
  const pieces = closed ? n : n - 1;
  for (let i = 0; i < pieces; i++) {
    const j = (i + 1) % n;
    const p1 = pts[i];
    const p2 = pts[j];
    // Arriving at a point the curve may run at a different speed than it leaves (a spline that was split or trimmed).
    const tj = tangentsIn?.[j] ?? t[j];
    const c1: P2 = [p1[0] + t[i][0] / 3, p1[1] + t[i][1] / 3];
    const c2: P2 = [p2[0] - tj[0] / 3, p2[1] - tj[1] / 3];
    out.push([p1, c1, c2, p2]);
  }
  return out;
}

/**
 * The handles of a spline walked the other way round (points reversed): each
 * point's leaving handle is its old arriving one turned round, and the other
 * way about.
 */
export function reversedHandles(tangents?: (P2 | undefined)[], tangentsIn?: (P2 | undefined)[]): { tangents: (P2 | undefined)[]; tangentsIn: (P2 | undefined)[] } {
  const n = Math.max(tangents?.length ?? 0, tangentsIn?.length ?? 0);
  const neg = (h: P2 | undefined): P2 | undefined => (h ? [-h[0], -h[1]] : undefined);
  const outs: (P2 | undefined)[] = [];
  const ins: (P2 | undefined)[] = [];
  for (let i = 0; i < n; i++) {
    const out = tangents?.[i];
    const inn = tangentsIn?.[i];
    // A point with only one handle set uses it both ways.
    outs.push(neg(inn ?? out));
    ins.push(inn ? neg(out) : undefined);
  }
  return { tangents: outs.reverse(), tangentsIn: ins.reverse() };
}

/** Split a cubic Bézier piece in two at t (de Casteljau): both halves follow the original exactly. */
export function splitBezier([a, b, c, d]: [P2, P2, P2, P2], t: number): [[P2, P2, P2, P2], [P2, P2, P2, P2]] {
  const lerp = (p: P2, q: P2): P2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const ab = lerp(a, b), bc = lerp(b, c), cd = lerp(c, d);
  const abc = lerp(ab, bc), bcd = lerp(bc, cd);
  const m = lerp(abc, bcd);
  return [
    [a, ab, abc, m],
    [m, bcd, cd, d],
  ];
}

/** The part of a Bézier piece between t0 and t1 (0 ≤ t0 < t1 ≤ 1). */
export function bezierBetween(b: [P2, P2, P2, P2], t0: number, t1: number): [P2, P2, P2, P2] {
  let piece = b;
  if (t1 < 1) piece = splitBezier(piece, t1)[0];
  if (t0 > 0) piece = splitBezier(piece, t0 / t1)[1];
  return piece;
}

/** Direction and speed (first derivative) of a Bézier piece at t. */
export function bezierD1([a, b, c, d]: [P2, P2, P2, P2], t: number): P2 {
  const u = 1 - t;
  const k0 = 3 * u * u, k1 = 6 * u * t, k2 = 3 * t * t;
  return [k0 * (b[0] - a[0]) + k1 * (c[0] - b[0]) + k2 * (d[0] - c[0]), k0 * (b[1] - a[1]) + k1 * (c[1] - b[1]) + k2 * (d[1] - c[1])];
}

/** Second derivative of a Bézier piece at t. */
export function bezierD2([a, b, c, d]: [P2, P2, P2, P2], t: number): P2 {
  const u = 1 - t;
  return [6 * u * (c[0] - 2 * b[0] + a[0]) + 6 * t * (d[0] - 2 * c[0] + b[0]), 6 * u * (c[1] - 2 * b[1] + a[1]) + 6 * t * (d[1] - 2 * c[1] + b[1])];
}

/** A point on the exact conic (rational quadratic) from a towards apex to b, at t (0…1). With its first and second derivatives. */
export function conicAt(a: P2, apex: P2, b: P2, rho: number, t: number): { p: P2; d1: P2; d2: P2 } {
  const r = Math.min(0.99, Math.max(0.01, rho));
  const w = r / (1 - r);
  const u = 1 - t;
  // Numerator N(t) and denominator D(t), with their derivatives.
  const k = [u * u, 2 * w * u * t, t * t];
  const dk = [-2 * u, 2 * w * (1 - 2 * t), 2 * t];
  const ddk = [2, -4 * w, 2];
  const comb = (c: number[], i: 0 | 1) => c[0] * a[i] + c[1] * apex[i] + c[2] * b[i];
  const D = k[0] + k[1] + k[2];
  const dD = dk[0] + dk[1] + dk[2];
  const ddD = ddk[0] + ddk[1] + ddk[2];
  const p: P2 = [comb(k, 0) / D, comb(k, 1) / D];
  const d1: P2 = [(comb(dk, 0) - p[0] * dD) / D, (comb(dk, 1) - p[1] * dD) / D];
  const d2: P2 = [(comb(ddk, 0) - 2 * d1[0] * dD - p[0] * ddD) / D, (comb(ddk, 1) - 2 * d1[1] * dD - p[1] * ddD) / D];
  return { p, d1, d2 };
}

/**
 * The part of a conic between t0 and t1, as a conic of its own: its two ends,
 * its corner and its fullness. Follows the original exactly.
 */
export function conicBetween(a: P2, apex: P2, b: P2, rho: number, t0: number, t1: number): { a: P2; apex: P2; b: P2; rho: number } {
  const r = Math.min(0.99, Math.max(0.01, rho));
  const w = r / (1 - r);
  // Homogeneous control points (x·w, y·w, w); a rational quadratic's piece is one too (blossoming).
  const H: [number, number, number][] = [
    [a[0], a[1], 1],
    [apex[0] * w, apex[1] * w, w],
    [b[0], b[1], 1],
  ];
  const at = (t: number, s: number): [number, number, number] => {
    // Blossom f(t, s) of the quadratic.
    const k0 = (1 - t) * (1 - s), k1 = (1 - t) * s + t * (1 - s), k2 = t * s;
    return [0, 1, 2].map((i) => k0 * H[0][i] + k1 * H[1][i] + k2 * H[2][i]) as [number, number, number];
  };
  const q0 = at(t0, t0), q1 = at(t0, t1), q2 = at(t1, t1);
  // Back to standard form: end weights 1, middle weight q1 / √(q0·q2).
  const nw = q1[2] / Math.sqrt(q0[2] * q2[2]);
  const nr = nw / (1 + nw);
  return { a: [q0[0] / q0[2], q0[1] / q0[2]], apex: [q1[0] / q1[2], q1[1] / q1[2]], b: [q2[0] / q2[2], q2[1] / q2[2]], rho: nr };
}

/** A point on one Bézier piece (t from 0 to 1). */
export function bezierAt([a, b, c, d]: [P2, P2, P2, P2], t: number): P2 {
  const u = 1 - t;
  const k0 = u * u * u;
  const k1 = 3 * u * u * t;
  const k2 = 3 * u * t * t;
  const k3 = t * t * t;
  return [k0 * a[0] + k1 * b[0] + k2 * c[0] + k3 * d[0], k0 * a[1] + k1 * b[1] + k2 * c[1] + k3 * d[1]];
}

/** The spline as short straight pieces (for drawing, picking and finding closed shapes). */
export function splinePolyline(pts: P2[], closed: boolean, steps = 16, conic?: number, tangents?: (P2 | undefined)[], tangentsIn?: (P2 | undefined)[]): P2[] {
  const pieces = splineBeziers(pts, closed, conic, tangents, tangentsIn);
  if (conic !== undefined) steps = Math.max(2, Math.round(steps / 3));
  if (!pieces.length) return pts.slice();
  const out: P2[] = [pieces[0][0]];
  for (const b of pieces) for (let k = 1; k <= steps; k++) out.push(bezierAt(b, k / steps));
  return out;
}
