"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MOOD_STATES, type LayerName, type Mood } from "./mascotMoodsData";

// ---------------------------------------------------------------------------
// Scene constants
// ---------------------------------------------------------------------------

const W = 290;
const H = 231;

export const MOODS: Mood[] = [
  "neutral",
  "angry",
  "mad",
  "sad",
  "sleep",
  "worried",
];

// Label is the visible chip text; tint colours the halo behind the figure.
const MOOD_META: Record<Mood, { label: string; tint: string }> = {
  neutral: { label: "Neutral", tint: "#FFF1BF" },
  angry: { label: "Angry", tint: "#FFD6D2" },
  mad: { label: "Mad", tint: "#E9E4DF" },
  sad: { label: "Sad", tint: "#D9E6FF" },
  sleep: { label: "Sleepy", tint: "#E3DEFF" },
  worried: { label: "Worried", tint: "#FFE4C8" },
};

// Every layer is sampled into a fixed number of points so any two states can
// be interpolated. Layers whose silhouette shares fixed features across
// states (the head's body, the nose inside the mouth) are sampled between
// anchors instead of uniformly, so those features get identical points in
// every state and sit perfectly still while the rest morphs.
//
// `collapse` says how a layer disappears when the target mood lacks it: pupils
// and sparkles shrink into their own centre, the brow slides up into the hair.
type Anchoring = {
  anchors: [number, number][]; // canvas coords, in path order
  counts: number[]; // points per segment (anchor i -> anchor i+1, wrapping)
};

type LayerSpec = {
  name: LayerName;
  fill: string;
  n: number;
  collapse: "center" | "up";
  eye?: boolean;
  rig?: "head" | "pupil" | "lid" | "mouth";
  anchoring?: Anchoring;
};

// Head: segment 0 runs from the right shoulder over the top (ears) to the
// left corner where the hair meets the body; segment 1 is the body itself,
// which is the same in every state.
const HEAD_TOP_N = 240;
const HEAD_ANCHORING: Anchoring = {
  anchors: [
    [284, 109.3],
    [99, 52.7],
  ],
  counts: [HEAD_TOP_N, 220],
};

// Mouth: the two anchors are the bottoms of the nose "stem". Segment 0 is
// the mouth line, segment 1 is the nose, which is the same in every state.
const MOUTH_ANCHORING: Anchoring = {
  anchors: [
    [182.35, 141.3],
    [185.4, 141.2],
  ],
  counts: [200, 60],
};

const LAYERS: LayerSpec[] = [
  { name: "head", fill: "#38201F", n: 300, collapse: "center", rig: "head", anchoring: HEAD_ANCHORING },
  { name: "eyeL", fill: "#FCC53C", n: 160, collapse: "center", eye: true, rig: "lid" },
  { name: "eyeR", fill: "#FCC53C", n: 160, collapse: "center", eye: true, rig: "lid" },
  { name: "pupilL", fill: "#38201F", n: 110, collapse: "center", eye: true, rig: "pupil" },
  { name: "pupilR", fill: "#38201F", n: 110, collapse: "center", eye: true, rig: "pupil" },
  { name: "sparkleL", fill: "#FFFFFF", n: 48, collapse: "center", eye: true, rig: "pupil" },
  { name: "sparkleR", fill: "#FFFFFF", n: 48, collapse: "center", eye: true, rig: "pupil" },
  { name: "chin", fill: "#FCC53C", n: 320, collapse: "center" },
  { name: "brow", fill: "#38201F", n: 90, collapse: "up" },
  { name: "mouth", fill: "#E42822", n: 200, collapse: "center", rig: "mouth", anchoring: MOUTH_ANCHORING },
];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type Points = Float32Array; // [x0, y0, x1, y1, ...]

// Every state's SVG has its own height; we bottom-align them on the 231px
// canvas so the body is a fixed anchor and only the hair moves.
function moodOffsetY(mood: Mood) {
  return H - MOOD_STATES[mood].height;
}

function sampleUniform(
  pathEl: SVGPathElement,
  d: string,
  n: number,
  dy: number,
): Points {
  pathEl.setAttribute("d", d);
  const len = pathEl.getTotalLength();
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = pathEl.getPointAtLength((len * i) / n);
    out[i * 2] = p.x;
    out[i * 2 + 1] = p.y + dy;
  }
  return out;
}

function sampleAnchored(
  pathEl: SVGPathElement,
  d: string,
  dy: number,
  { anchors, counts }: Anchoring,
): Points {
  pathEl.setAttribute("d", d);
  const len = pathEl.getTotalLength();
  // Locate each anchor's arc length by scanning a dense sampling.
  const DENSE = 1500;
  const dense: [number, number][] = [];
  for (let i = 0; i < DENSE; i++) {
    const p = pathEl.getPointAtLength((len * i) / DENSE);
    dense.push([p.x, p.y + dy]);
  }
  const at = anchors.map(([ax, ay]) => {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < DENSE; i++) {
      const dx = dense[i][0] - ax;
      const dyy = dense[i][1] - ay;
      const dd = dx * dx + dyy * dyy;
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    return (len * best) / DENSE;
  });
  const total = counts.reduce((a, b) => a + b, 0);
  const out = new Float32Array(total * 2);
  let k = 0;
  for (let s = 0; s < anchors.length; s++) {
    const s0 = at[s];
    const s1 = at[(s + 1) % anchors.length];
    const segLen = (((s1 - s0) % len) + len) % len || len;
    for (let j = 0; j < counts[s]; j++) {
      const p = pathEl.getPointAtLength((s0 + (segLen * j) / counts[s]) % len);
      out[k++] = p.x;
      out[k++] = p.y + dy;
    }
  }
  return out;
}

function centroid(pts: Points): [number, number] {
  let x = 0;
  let y = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    x += pts[i * 2];
    y += pts[i * 2 + 1];
  }
  return [x / n, y / n];
}

function collapsed(pts: Points, mode: "center" | "up"): Points {
  const out = new Float32Array(pts.length);
  const n = pts.length / 2;
  if (mode === "center") {
    const [cx, cy] = centroid(pts);
    for (let i = 0; i < n; i++) {
      out[i * 2] = cx + (pts[i * 2] - cx) * 0.02;
      out[i * 2 + 1] = cy + (pts[i * 2 + 1] - cy) * 0.02;
    }
  } else {
    let minY = Infinity;
    for (let i = 0; i < n; i++) minY = Math.min(minY, pts[i * 2 + 1]);
    for (let i = 0; i < n; i++) {
      out[i * 2] = pts[i * 2];
      out[i * 2 + 1] = minY + (pts[i * 2 + 1] - minY) * 0.02;
    }
  }
  return out;
}

// Rotate (and possibly reverse) `to` so that point i of `from` travels to the
// nearest sensible point i of `to`. Without this the shape twists around
// itself mid-morph. Anchored layers skip this: their correspondence is fixed.
function aligned(from: Points, to: Points): Points {
  const n = from.length / 2;
  let best = Infinity;
  let bestK = 0;
  let bestRev = false;
  for (const rev of [false, true]) {
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const j = rev ? (k - i + n) % n : (i + k) % n;
        const dx = from[i * 2] - to[j * 2];
        const dy = from[i * 2 + 1] - to[j * 2 + 1];
        s += dx * dx + dy * dy;
        if (s >= best) break;
      }
      if (s < best) {
        best = s;
        bestK = k;
        bestRev = rev;
      }
    }
  }
  const out = new Float32Array(from.length);
  for (let i = 0; i < n; i++) {
    const j = bestRev ? (bestK - i + n) % n : (i + bestK) % n;
    out[i * 2] = to[j * 2];
    out[i * 2 + 1] = to[j * 2 + 1];
  }
  return out;
}

// Closed centripetal Catmull-Rom spline through the sampled points, emitted
// as cubic Béziers. Straight segments show their corners at any zoom; the
// centripetal form rounds the polygon without overshooting into loops at
// sharp features like ear tips.
function toPathData(pts: Points): string {
  const n = pts.length / 2;
  if (n < 4) return "";
  const x = (i: number) => pts[((i + n) % n) * 2];
  const y = (i: number) => pts[((i + n) % n) * 2 + 1];
  let s = `M${x(0).toFixed(2)} ${y(0).toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const x0 = x(i - 1), y0 = y(i - 1);
    const x1 = x(i), y1 = y(i);
    const x2 = x(i + 1), y2 = y(i + 1);
    const x3 = x(i + 2), y3 = y(i + 2);
    // Centripetal parameterisation: alpha = 0.5.
    const d01 = Math.sqrt(Math.hypot(x1 - x0, y1 - y0)) || 1e-4;
    const d12 = Math.sqrt(Math.hypot(x2 - x1, y2 - y1)) || 1e-4;
    const d23 = Math.sqrt(Math.hypot(x3 - x2, y3 - y2)) || 1e-4;
    const a1 = d12 / (d01 + d12);
    const a2 = d12 / (d12 + d23);
    const c1x = x1 + (a1 * (x2 - x0) * d12) / (d01 + d12) / 3;
    const c1y = y1 + (a1 * (y2 - y0) * d12) / (d01 + d12) / 3;
    const c2x = x2 - (a2 * (x3 - x1) * d12) / (d12 + d23) / 3;
    const c2y = y2 - (a2 * (y3 - y1) * d12) / (d12 + d23) / 3;
    s += `C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }
  return s + "Z";
}

// Apple-style spring: perceptual duration + bounce, same mapping Motion uses.
function makeSpring(duration: number, bounce: number) {
  const w0 = (2 * Math.PI) / duration;
  const z = Math.min(0.999, 1 - bounce);
  const wd = w0 * Math.sqrt(1 - z * z);
  return (t: number) =>
    1 -
    Math.exp(-z * w0 * t) *
      (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
}

// Exponential approach: frame-rate independent smoothing toward a target.
function approach(v: number, target: number, k: number, dt: number) {
  return v + (target - v) * (1 - Math.exp(-k * dt));
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

// ---------------------------------------------------------------------------
// Engine: owns the per-layer point buffers, runs the morph and the idle rigs
// (ears, pupils), and writes `d` straight to the DOM each frame so React
// never re-renders during motion.
// ---------------------------------------------------------------------------

type LayerRun = {
  spec: LayerSpec;
  el: SVGPathElement;
  cur: Points; // interpolated base shape
  out: Points; // base + rig deformation, what gets painted
  from: Points;
  to: Points;
  fromA: number;
  toA: number;
  curA: number;
};

type Vec = { x: number; y: number };

// Ear tips are the points of the head's top segment that rise above this
// line; the deformation weight grows with height so the base stays put.
const EAR_BASE_Y = 60;

class MascotEngine {
  private shapes = new Map<Mood, Map<LayerName, Points>>();
  private layers: LayerRun[] = [];
  private raf = 0;
  private lastNow = 0;
  private mood: Mood;

  private morphT0 = -1;
  private duration = 0.64;
  private spring = makeSpring(0.64, 0.14);

  // Ear rig: smoothed offsets per side, plus a one-shot flick.
  private ear = { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } };
  private flick = { side: "L" as "L" | "R", t0: -10, next: 2.2 };

  // Pupil rig: smoothed offset toward a target that behaviours move around.
  private pupil: Vec = { x: 0, y: 0 };
  private pupilTarget: Vec = { x: 0, y: 0 };
  private nextGlance = 1.5;
  private glanceUntil = 0;
  private roll = { t0: -10, next: 2.5 };

  // Sleep rig: the closed lids and the mouth line ride the breath, and one
  // lid twitches now and then.
  private twitch = { side: "L" as "L" | "R", t0: -10, next: 3 };

  constructor(
    els: Map<LayerName, SVGPathElement>,
    initial: Mood,
    private reduced: boolean,
  ) {
    // Sample every mood's every layer once, up front.
    const svgNS = "http://www.w3.org/2000/svg";
    const scratch = document.createElementNS(svgNS, "svg");
    scratch.setAttribute("aria-hidden", "true");
    scratch.style.cssText =
      "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden";
    const probe = document.createElementNS(svgNS, "path");
    scratch.appendChild(probe);
    document.body.appendChild(scratch);

    for (const mood of MOODS) {
      const dy = moodOffsetY(mood);
      const m = new Map<LayerName, Points>();
      for (const spec of LAYERS) {
        const d = MOOD_STATES[mood].paths[spec.name];
        if (!d) continue;
        m.set(
          spec.name,
          spec.anchoring
            ? sampleAnchored(probe, d, dy, spec.anchoring)
            : sampleUniform(probe, d, spec.n, dy),
        );
      }
      this.shapes.set(mood, m);
    }
    scratch.remove();

    if (reduced) {
      this.duration = 0.32;
      this.spring = makeSpring(0.32, 0);
    }

    this.mood = initial;
    const init = this.shapes.get(initial)!;
    for (const spec of LAYERS) {
      const el = els.get(spec.name)!;
      const pts = init.get(spec.name);
      const cur = pts
        ? Float32Array.from(pts)
        : collapsed(this.anyShape(spec.name), spec.collapse);
      const a = pts ? 1 : 0;
      this.layers.push({
        spec,
        el,
        cur,
        out: Float32Array.from(cur),
        from: cur,
        to: cur,
        fromA: a,
        toA: a,
        curA: a,
      });
    }
    this.lastNow = performance.now();
    this.paintAll(true);
    this.raf = requestAnimationFrame(this.tick);
  }

  private anyShape(name: LayerName): Points {
    for (const mood of MOODS) {
      const p = this.shapes.get(mood)!.get(name);
      if (p) return p;
    }
    throw new Error(`no shape for ${name}`);
  }

  goTo(mood: Mood) {
    const target = this.shapes.get(mood)!;
    for (const run of this.layers) {
      const next = target.get(run.spec.name);
      // Interruptible: always depart from wherever the layer is right now.
      run.from = Float32Array.from(run.cur);
      run.fromA = run.curA;
      if (next) {
        // Arriving from hidden? Grow out of the collapsed version of the
        // destination rather than from the last visible shape's remnants.
        if (run.curA === 0) run.from = collapsed(next, run.spec.collapse);
        run.to = run.spec.anchoring ? next : aligned(run.from, next);
        run.toA = 1;
      } else {
        run.to = collapsed(run.from, run.spec.collapse);
        run.toA = 0;
      }
    }
    this.mood = mood;
    this.morphT0 = performance.now();
    // Fresh mood, fresh schedule: the first glance/flick lands soon after the
    // morph settles so the new state reads as alive right away.
    const t = this.morphT0 / 1000;
    this.nextGlance = t + rand(0.9, 1.6);
    this.flick.next = t + rand(1.2, 2.4);
    this.roll.next = t + rand(1.4, 2.2);
    this.twitch.next = t + rand(2.5, 4);
    this.glanceUntil = 0;
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }

  // -- frame ----------------------------------------------------------------

  private tick = (now: number) => {
    const dt = Math.min(0.05, (now - this.lastNow) / 1000);
    this.lastNow = now;
    const t = now / 1000;

    let morphing = false;
    if (this.morphT0 >= 0) {
      const mt = (now - this.morphT0) / 1000;
      const done = mt >= this.duration * 1.6;
      const p = done ? 1 : this.spring(mt);
      for (const run of this.layers) {
        const { from, to, cur } = run;
        for (let i = 0; i < cur.length; i++) {
          cur[i] = from[i] + (to[i] - from[i]) * p;
        }
        run.curA = Math.min(1, Math.max(0, run.fromA + (run.toA - run.fromA) * p));
      }
      if (done) this.morphT0 = -1;
      morphing = true;
    }

    if (!this.reduced) {
      this.updateEars(t, dt);
      this.updatePupils(t, dt);
      this.updateSleep(t);
    }
    this.paintAll(morphing);
    this.raf = requestAnimationFrame(this.tick);
  };

  private paintAll(morphing: boolean) {
    for (const run of this.layers) {
      const rig = run.spec.rig;
      // Static layers only need a write while the morph moves them.
      if (!morphing && !rig) continue;
      if (rig === "head") this.applyEars(run);
      else if (rig === "pupil") this.applyPupils(run);
      else if (rig === "lid") this.applyLid(run);
      else if (rig === "mouth") this.applyMouth(run);
      else run.out.set(run.cur);
      run.el.setAttribute("d", toPathData(run.out));
      run.el.style.opacity = String(run.curA);
    }
  }

  // -- ears -----------------------------------------------------------------

  // Resting ear pose per mood (x is "outward", positive = away from centre).
  private earPose(t: number): { L: Vec; R: Vec } {
    const sway = Math.sin(t * 1.1);
    const pose = (outward: number): Vec => {
      switch (this.mood) {
        case "sad":
          return { x: outward * (7 + 1.5 * sway), y: 11 + 2 * Math.sin(t * 1.1 + 1) };
        case "angry": {
          // Pinned back, and they bounce with every stomp (1.15s loop).
          const stomp = Math.max(0, Math.sin(((t % 1.15) / 1.15) * Math.PI * 2 - 1.2));
          return { x: -outward * 4, y: 6 + 6 * stomp * stomp };
        }
        case "mad":
          return { x: outward * 11, y: 8 };
        case "sleep":
          return { x: outward * 3, y: 5 + 2.5 * Math.sin(t * 2.03) };
        case "worried":
          return {
            x: outward * 2 + 1.4 * Math.sin(t * 47),
            y: 3 + 1.1 * Math.sin(t * 41 + 0.7),
          };
        default:
          return { x: 0, y: 0 };
      }
    };
    return { L: pose(-1), R: pose(1) };
  }

  private updateEars(t: number, dt: number) {
    const pose = this.earPose(t);
    const k = this.mood === "sad" ? 4 : this.mood === "angry" ? 18 : 9;
    this.ear.L.x = approach(this.ear.L.x, pose.L.x, k, dt);
    this.ear.L.y = approach(this.ear.L.y, pose.L.y, k, dt);
    this.ear.R.x = approach(this.ear.R.x, pose.R.x, k, dt);
    this.ear.R.y = approach(this.ear.R.y, pose.R.y, k, dt);

    // Flicks: a quick twitch of one ear, at irregular intervals, when calm.
    if ((this.mood === "neutral" || this.mood === "sleep") && t >= this.flick.next) {
      this.flick.side = Math.random() < 0.5 ? "L" : "R";
      this.flick.t0 = t;
      this.flick.next = t + rand(2.6, 6.5);
    }
  }

  private applyEars(run: LayerRun) {
    const { cur, out } = run;
    out.set(cur);
    const n = HEAD_TOP_N;
    // Height of the tallest ear right now, so weights are relative to the
    // current silhouette rather than a fixed number.
    let minY = Infinity;
    let sx = 0;
    let sc = 0;
    for (let i = 0; i < n; i++) minY = Math.min(minY, cur[i * 2 + 1]);
    const hTop = Math.max(8, EAR_BASE_Y - minY);
    for (let i = 0; i < n; i++) {
      if (EAR_BASE_Y - cur[i * 2 + 1] > hTop * 0.3) {
        sx += cur[i * 2];
        sc++;
      }
    }
    const splitX = sc ? sx / sc : W / 2;

    const now = this.lastNow / 1000;
    const fu = (now - this.flick.t0) / 0.26;
    const flickAmt = fu > 0 && fu < 1 ? Math.sin(Math.PI * fu) : 0;

    // Flick folds one ear back toward the centre and down, then releases.
    const flickL = this.flick.side === "L" ? flickAmt : 0;
    const flickR = this.flick.side === "R" ? flickAmt : 0;
    for (let i = 0; i < n; i++) {
      const x = cur[i * 2];
      const y = cur[i * 2 + 1];
      const h = EAR_BASE_Y - y;
      if (h <= 0) continue;
      const w = Math.pow(Math.min(1, h / hTop), 1.7);
      // Blend between the two ears over a band around the split rather
      // than switching at a line, so the valley between them stays smooth.
      const m = Math.min(1, Math.max(0, (x - splitX) / 40 + 0.5));
      const dx =
        (this.ear.L.x + 7 * flickL) * (1 - m) + (this.ear.R.x - 7 * flickR) * m;
      const dy =
        (this.ear.L.y + 6 * flickL) * (1 - m) + (this.ear.R.y + 6 * flickR) * m;
      out[i * 2] = x + w * dx;
      out[i * 2 + 1] = y + w * dy;
    }
  }

  // -- sleep: lids and mouth ------------------------------------------------

  private breath(t: number) {
    // Same period as the body bob (3.1s) so everything breathes together.
    return Math.sin(t * 2.03);
  }

  private updateSleep(t: number) {
    if (this.mood !== "sleep") return;
    if (t >= this.twitch.next) {
      this.twitch.side = Math.random() < 0.5 ? "L" : "R";
      this.twitch.t0 = t;
      this.twitch.next = t + rand(2.8, 6.5);
    }
  }

  private applyLid(run: LayerRun) {
    const { cur, out } = run;
    out.set(cur);
    if (this.mood !== "sleep" || this.morphT0 >= 0) return;
    const t = this.lastNow / 1000;
    const side = run.spec.name === "eyeL" ? "L" : "R";
    // Lids sink a hair on the exhale.
    const dy = 0.7 * this.breath(t);
    // The twitch: a quick squeeze of one lid, like a dream flicker.
    const u = (t - this.twitch.t0) / 0.32;
    const tw = side === this.twitch.side && u > 0 && u < 1 ? Math.sin(Math.PI * u) : 0;
    if (tw) {
      // Pull the lid's outer half up slightly and the whole lid down.
      let minX = Infinity;
      let maxX = -Infinity;
      for (let i = 0; i < cur.length; i += 2) {
        minX = Math.min(minX, cur[i]);
        maxX = Math.max(maxX, cur[i]);
      }
      const span = Math.max(1, maxX - minX);
      for (let i = 0; i < cur.length; i += 2) {
        const f = (cur[i] - minX) / span; // 0 inner..1 outer, roughly
        const lift = side === "L" ? 1 - f : f;
        out[i + 1] = cur[i + 1] + dy + tw * (1.6 - 2.4 * lift);
      }
      return;
    }
    for (let i = 1; i < cur.length; i += 2) out[i] = cur[i] + dy;
  }

  private applyMouth(run: LayerRun) {
    const { cur, out } = run;
    out.set(cur);
    if (this.mood !== "sleep" || this.morphT0 >= 0) return;
    const b = this.breath(this.lastNow / 1000);
    // Only the mouth line (segment 0) moves; the nose stays put. It widens a
    // touch on the inhale and settles on the exhale.
    const n = MOUTH_ANCHORING.counts[0];
    const cxm = 190;
    const sx = 1 + 0.025 * b;
    for (let i = 0; i < n; i++) {
      out[i * 2] = cxm + (cur[i * 2] - cxm) * sx;
      out[i * 2 + 1] = cur[i * 2 + 1] + 0.8 * b;
    }
  }

  // -- pupils ---------------------------------------------------------------

  private updatePupils(t: number, dt: number) {
    let target: Vec = { x: 0, y: 0 };
    let k = 16;
    switch (this.mood) {
      case "neutral": {
        // Saccades: glance somewhere, hold, come back.
        if (t >= this.nextGlance) {
          this.pupilTarget = { x: rand(-6, 6), y: rand(-2.5, 2) };
          this.glanceUntil = t + rand(0.7, 1.8);
          this.nextGlance = this.glanceUntil + rand(1.2, 3.5);
        }
        target = t < this.glanceUntil ? this.pupilTarget : { x: 0, y: 0 };
        break;
      }
      case "sad":
        target = { x: 1.5 * Math.sin(t * 0.6), y: 4 };
        k = 5;
        break;
      case "mad": {
        // Side-eye at rest, with the occasional full eye-roll over the top.
        if (t >= this.roll.next) {
          this.roll.t0 = t;
          this.roll.next = t + rand(3.5, 6.5);
        }
        const u = (t - this.roll.t0) / 1.05;
        if (u >= 0 && u < 1) {
          target = { x: 6 * Math.cos(Math.PI * u), y: -6.5 * Math.sin(Math.PI * u) };
          k = 14;
        } else {
          target = { x: -5.5, y: -1 };
          k = 8;
        }
        break;
      }
      case "angry":
        target = { x: 0.3 * Math.sin(t * 31), y: 0.6 };
        k = 20;
        break;
      case "worried": {
        // Darting: new random spot every few hundred milliseconds.
        if (t >= this.nextGlance) {
          this.pupilTarget = { x: rand(-6, 6), y: rand(-2, 2) };
          this.nextGlance = t + rand(0.3, 0.9);
        }
        target = this.pupilTarget;
        k = 24;
        break;
      }
      default:
        target = { x: 0, y: 0 };
    }
    this.pupil.x = approach(this.pupil.x, target.x, k, dt);
    this.pupil.y = approach(this.pupil.y, target.y, k, dt);
  }

  private applyPupils(run: LayerRun) {
    const { cur, out } = run;
    const { x, y } = this.pupil;
    for (let i = 0; i < cur.length; i += 2) {
      out[i] = cur[i] + x;
      out[i + 1] = cur[i + 1] + y;
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const REACTION: Record<Mood, { name: string; ms: number }> = {
  neutral: { name: "mascot-pop", ms: 620 },
  angry: { name: "mascot-rage", ms: 900 },
  mad: { name: "mascot-huff", ms: 620 },
  sad: { name: "mascot-sink", ms: 620 },
  sleep: { name: "mascot-sink", ms: 620 },
  worried: { name: "mascot-jolt", ms: 620 },
};

function restartAnimation(el: SVGElement | null, name: string, ms: number) {
  if (!el) return;
  el.style.animation = "none";
  // Force a style flush so the same animation name can run again.
  void el.getBoundingClientRect();
  el.style.animation = `${name} ${ms}ms cubic-bezier(0.22, 1, 0.36, 1) both`;
}

export default function MascotMoods() {
  const [mood, setMood] = useState<Mood>("neutral");
  const [autoplay, setAutoplay] = useState(false);
  const moodRef = useRef<Mood>("neutral");
  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  const engineRef = useRef<MascotEngine | null>(null);
  const pathEls = useRef(new Map<LayerName, SVGPathElement>());
  const reactionRef = useRef<SVGGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);
  const reducedRef = useRef(false);

  // Build the engine once the paths exist.
  useEffect(() => {
    reducedRef.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const engine = new MascotEngine(
      pathEls.current,
      moodRef.current,
      reducedRef.current,
    );
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // Drive the morph + the one-shot body reaction on every mood change.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    engineRef.current?.goTo(mood);
    if (!reducedRef.current) {
      const r = REACTION[mood];
      restartAnimation(reactionRef.current, r.name, r.ms);
    }
  }, [mood]);

  // Blink at irregular intervals, never while asleep.
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          if (moodRef.current !== "sleep" && !reducedRef.current) {
            restartAnimation(eyesRef.current, "mascot-blink", 170);
            // Occasional double blink reads as more alive than a metronome.
            if (Math.random() < 0.25) {
              window.setTimeout(
                () => restartAnimation(eyesRef.current, "mascot-blink", 170),
                260,
              );
            }
          }
          schedule();
        },
        2400 + Math.random() * 3200,
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  const step = useCallback((dir: 1 | -1) => {
    setMood((m) => MOODS[(MOODS.indexOf(m) + dir + MOODS.length) % MOODS.length]);
  }, []);

  useEffect(() => {
    if (!autoplay) return;
    const id = window.setInterval(() => step(1), 2800);
    return () => window.clearInterval(id);
  }, [autoplay, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        setAutoplay((a) => !a);
      } else if (/^[1-6]$/.test(e.key)) {
        setMood(MOODS[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  const meta = MOOD_META[mood];
  const initial = MOOD_STATES.neutral.paths;

  const renderLayer = (l: LayerSpec) => (
    <path
      key={l.name}
      ref={(el) => {
        if (el) pathEls.current.set(l.name, el);
      }}
      d={initial[l.name] ?? ""}
      fill={l.fill}
      style={{ opacity: initial[l.name] ? 1 : 0 }}
    />
  );

  return (
    <div
      className="mascot-stage flex min-h-dvh flex-col px-6 py-6 sm:px-10 sm:py-8"
      data-mood={mood}
    >
      <style>{STYLES}</style>

      <header className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div>
          <h1 className="text-base font-semibold tracking-tight text-neutral-900">
            Mascot moods
          </h1>
          <p className="mt-0.5 text-sm text-neutral-500">
            Six states, one morphing SVG. Pick a mood or click the character.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <p className="hidden items-center gap-1.5 text-xs text-neutral-500 md:flex">
            <kbd className="mascot-kbd">←</kbd>
            <kbd className="mascot-kbd">→</kbd>
            <span className="mr-2">switch</span>
            <kbd className="mascot-kbd">1–6</kbd>
            <span className="mr-2">jump</span>
            <kbd className="mascot-kbd">space</kbd>
            <span>autoplay</span>
          </p>
          <button
            type="button"
            onClick={() => setAutoplay((a) => !a)}
            aria-pressed={autoplay}
            className="mascot-chip flex h-9 items-center gap-2 rounded-full border border-neutral-200 bg-white px-3.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${
                autoplay ? "bg-emerald-500" : "bg-neutral-300"
              }`}
            />
            {autoplay ? "Autoplay on" : "Autoplay"}
          </button>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-8 py-8">
        <div className="relative w-full max-w-[520px]">
          {/* Mood-coloured halo; only its colour changes, so it stays cheap. */}
          <div
            aria-hidden
            className="mascot-halo pointer-events-none absolute left-1/2 top-1/2 size-[420px] -translate-x-1/2 -translate-y-[46%] rounded-full blur-3xl"
            style={{ backgroundColor: meta.tint }}
          />

          <button
            type="button"
            onClick={() => step(1)}
            aria-label={`Mood: ${meta.label}. Next mood`}
            className="mascot-figure relative block w-full cursor-pointer rounded-3xl"
          >
            <svg
              viewBox={`0 ${-40} ${W} ${H + 40}`}
              className="block h-auto w-full overflow-visible"
              aria-hidden
            >
              {/* Ground shadow: squashes when the body lands a stomp. */}
              <ellipse
                className="mascot-shadow"
                cx="145"
                cy="232"
                rx="118"
                ry="5"
                fill="#38201F"
                fillOpacity="0.12"
              />

              {/* Outer group: the sustained idle for the current mood. */}
              <g className="mascot-idle">
                {/* Inner group: the one-shot reaction on mood change. */}
                <g className="mascot-react" ref={reactionRef}>
                  {LAYERS.filter((l) => l.name === "head").map(renderLayer)}
                  {/* Eyes sit between the head and the brow so the brow can
                      cover their tops, exactly as the source SVGs stack them. */}
                  <g className="mascot-eyes" ref={eyesRef}>
                    {LAYERS.filter((l) => l.eye).map(renderLayer)}
                  </g>
                  {LAYERS.filter((l) => !l.eye && l.name !== "head").map(
                    renderLayer,
                  )}
                </g>
              </g>

              {/* Sleep-only: drifting z's, staggered so they never line up. */}
              <g
                className="mascot-zzz"
                fill="#38201F"
                fontFamily='ui-rounded, "SF Pro Rounded", var(--font-sans), sans-serif'
                fontWeight={800}
              >
                <text x="238" y="36" fontSize="14">
                  z
                </text>
                <text x="252" y="22" fontSize="20">
                  z
                </text>
                <text x="270" y="6" fontSize="27">
                  z
                </text>
              </g>
            </svg>
          </button>
        </div>

        {/* Announces the mood for screen readers; the active chip is the
            visible label. */}
        <p role="status" className="sr-only">
          Mood: {meta.label}
        </p>

        <div
          role="group"
          aria-label="Mood"
          className="grid w-full max-w-[420px] grid-cols-3 gap-1 rounded-2xl bg-neutral-100 p-1 sm:flex sm:w-auto sm:max-w-none sm:rounded-full"
        >
          {MOODS.map((m) => {
            const active = m === mood;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={active}
                onClick={() => setMood(m)}
                className={`mascot-chip h-9 rounded-xl px-4 text-sm font-medium sm:rounded-full ${
                  active
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-600 hover:text-neutral-900"
                }`}
              >
                {MOOD_META[m].label}
              </button>
            );
          })}
        </div>
      </main>
    </div>
  );
}

// Scoped styles. Everything animates transform/opacity only. Groups use
// fill-box so their origin follows the drawing; the props use view-box
// origins in canvas units so they pivot around their own anchor.
const STYLES = `
.mascot-halo { transition: background-color 700ms ease; opacity: .75; }

.mascot-chip { transition: scale 150ms cubic-bezier(0.25, 0.46, 0.45, 0.94), background-color 150ms ease, color 150ms ease, box-shadow 150ms ease; }
.mascot-chip:active { scale: 0.96; }

.mascot-kbd {
  display: inline-block;
  min-width: 1.5rem;
  padding: 0 0.3rem;
  border: 1px solid var(--color-neutral-200);
  border-radius: 0.375rem;
  text-align: center;
  font-family: var(--font-mono), monospace;
  font-size: 11px;
  line-height: 1.25rem;
  color: var(--color-neutral-600);
}

.mascot-idle, .mascot-react, .mascot-eyes {
  transform-box: fill-box;
  transform-origin: 50% 100%;
}
.mascot-eyes { transform-origin: 50% 50%; }

.mascot-shadow {
  transform-box: view-box;
  transform-origin: 145px 232px;
  opacity: 0;
  transition: opacity 400ms ease;
}
[data-mood="angry"] .mascot-shadow { opacity: 1; animation: mascot-shadow-stomp 1.15s linear infinite; }

/* Sustained per-mood idle on the outer group. Non-syncing durations. */
.mascot-idle {
  transition: transform 700ms cubic-bezier(0.22, 1, 0.36, 1);
  animation: mascot-breathe 3.4s ease-in-out infinite;
}
[data-mood="angry"]   .mascot-idle { animation: mascot-stomp 1.15s linear infinite; }
[data-mood="mad"]     .mascot-idle { animation: mascot-breathe 4.2s ease-in-out infinite; transform: rotate(-2.5deg); }
[data-mood="sad"]     .mascot-idle { animation: mascot-sniffle 4.8s ease-in-out infinite; transform: translateY(6px) rotate(-2deg) scale(0.985); }
[data-mood="sleep"]   .mascot-idle { animation: mascot-bob 3.1s ease-in-out infinite; }
[data-mood="worried"] .mascot-idle { animation: mascot-tremble 0.14s linear infinite; }


.mascot-zzz { opacity: 0; transition: opacity 500ms ease; }
[data-mood="sleep"] .mascot-zzz { opacity: 1; }
.mascot-zzz text { animation: mascot-zzz 2.4s ease-in-out infinite; transform-box: fill-box; }
.mascot-zzz text:nth-child(2) { animation-delay: .8s; }
.mascot-zzz text:nth-child(3) { animation-delay: 1.6s; }
[data-mood]:not([data-mood="sleep"]) .mascot-zzz text { animation-play-state: paused; }


@keyframes mascot-breathe {
  0%, 100% { transform: scale(1, 1); }
  50%      { transform: scale(1.012, 1.02); }
}
@keyframes mascot-sniffle {
  0%, 100% { transform: translateY(6px) rotate(-2deg) scale(0.985); }
  40%      { transform: translateY(6.5px) rotate(-2.2deg) scale(0.98, 0.99); }
  46%      { transform: translateY(5px) rotate(-1.6deg) scale(0.99, 1.0); }
  52%      { transform: translateY(6px) rotate(-2deg) scale(0.985); }
}
@keyframes mascot-bob {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50%      { transform: translateY(5px) rotate(2.5deg); }
}
/* Angry: crouch, launch, hang, slam down, and shudder from the impact. */
@keyframes mascot-stomp {
  0%   { transform: translate(0, 0) scale(1, 1); }
  14%  { transform: translate(0, 4px) scale(1.07, 0.9); }        /* crouch */
  22%  { transform: translate(0, -18px) scale(0.95, 1.08); }     /* launch */
  34%  { transform: translate(0, -24px) scale(0.98, 1.03); }     /* apex */
  44%  { transform: translate(0, -6px) scale(0.97, 1.06); }      /* falling */
  50%  { transform: translate(0, 2px) scale(1.12, 0.86); }       /* slam */
  56%  { transform: translate(-3px, 0) scale(1.04, 0.97); }      /* shudder */
  62%  { transform: translate(3px, 0) scale(1.0, 1.02); }
  68%  { transform: translate(-2px, 0) scale(1.01, 0.99); }
  74%  { transform: translate(1px, 0) scale(1, 1); }
  100% { transform: translate(0, 0) scale(1, 1); }
}
@keyframes mascot-shadow-stomp {
  0%   { transform: scale(1, 1); opacity: 1; }
  14%  { transform: scale(1.06, 1.2); opacity: 1; }
  34%  { transform: scale(0.72, 0.7); opacity: 0.5; }            /* airborne */
  50%  { transform: scale(1.18, 1.3); opacity: 1; }              /* slam */
  62%  { transform: scale(1.02, 1); opacity: 1; }
  100% { transform: scale(1, 1); opacity: 1; }
}
@keyframes mascot-tremble {
  0%   { transform: translate(0, 0); }
  25%  { transform: translate(-0.7px, 0.25px); }
  50%  { transform: translate(0.6px, -0.2px); }
  75%  { transform: translate(-0.5px, -0.3px); }
  100% { transform: translate(0, 0); }
}

/* One-shot reactions on the inner group. */
@keyframes mascot-pop {
  0%   { transform: scale(1, 1); }
  30%  { transform: scale(1.06, 0.92); }
  60%  { transform: scale(0.97, 1.05); }
  100% { transform: scale(1, 1); }
}
/* Entering angry: a big rear-up, then a hard shake. */
@keyframes mascot-rage {
  0%   { transform: translateY(0) scale(1, 1) rotate(0); }
  18%  { transform: translateY(-14px) scale(0.94, 1.1) rotate(0); }
  30%  { transform: translateY(0) scale(1.1, 0.9) rotate(0); }
  40%  { transform: translateX(-8px) scale(1.02, 0.98) rotate(-2.5deg); }
  50%  { transform: translateX(8px) scale(1, 1) rotate(2deg); }
  60%  { transform: translateX(-6px) rotate(-1.5deg); }
  70%  { transform: translateX(5px) rotate(1deg); }
  80%  { transform: translateX(-3px) rotate(-0.5deg); }
  100% { transform: translate(0, 0) scale(1, 1) rotate(0); }
}
@keyframes mascot-huff {
  0%   { transform: scale(1, 1); }
  35%  { transform: scale(1.04, 0.95) translateY(2px); }
  70%  { transform: scale(0.99, 1.02) translateY(-1px); }
  100% { transform: scale(1, 1); }
}
@keyframes mascot-sink {
  0%   { transform: scale(1, 1); }
  45%  { transform: scale(1.03, 0.94); }
  100% { transform: scale(1, 1); }
}
@keyframes mascot-jolt {
  0%   { transform: translateY(0) scale(1, 1); }
  20%  { transform: translateY(-12px) scale(0.96, 1.06); }
  55%  { transform: translateY(2px) scale(1.04, 0.96); }
  100% { transform: translateY(0) scale(1, 1); }
}
@keyframes mascot-blink {
  0%, 100% { transform: scaleY(1); }
  50%      { transform: scaleY(0.08); }
}
@keyframes mascot-zzz {
  0%   { opacity: 0; transform: translate(0, 6px) scale(0.8); }
  25%  { opacity: 1; }
  80%  { opacity: 0; }
  100% { opacity: 0; transform: translate(14px, -26px) scale(1.15); }
}


@media (prefers-reduced-motion: reduce) {
  .mascot-idle, .mascot-eyes, .mascot-zzz text, .mascot-shadow { animation: none !important; }
  .mascot-idle { transition: none; transform: none !important; }
  .mascot-halo { transition: background-color 300ms ease; }
}
`;
