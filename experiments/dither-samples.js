// Dither experiments from the 2026 redesign: the sky window, plates, a cursor-lit relief and a stirrable
// ink fluid, with a switcher. Not used by the site (static/sky.js is the live version of the sky and plates).
// To try them, load this file on a built home page: <script src="/experiments/dither-samples.js" defer>

// Four front-page samples where dither is how something real gets drawn.
// 1 Window: the live sky over Copenhagen · 2 Relief: terrain lit by your cursor
// 3 Artifacts: a generated plate per post · 4 Ink: a fluid you can stir
// Two tones only (ink on paper), blue-noise or error-diffusion dithering, redrawn on theme change.

const root = document.documentElement;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const tok = (n) => getComputedStyle(root).getPropertyValue(n).trim();
const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, t) => { const u = clamp((t - a) / (b - a)); return u * u * (3 - 2 * u); };
const mix = (a, b, t) => a + (b - a) * t;
const dark = () => root.classList.contains("dark");

/* ================= blue noise (void-and-cluster, 64×64, built once) ================= */
const BN = (() => {
  const N = 64, S = N * N, sigma = 1.9, K = new Float32Array(S);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = Math.min(x, N - x), dy = Math.min(y, N - y);
    K[y * N + x] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
  }
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const toggle = (E, i, s) => {
    const x0 = i % N, y0 = (i / N) | 0;
    for (let y = 0; y < N; y++) { const ky = ((y - y0 + N) % N) * N, ey = y * N; for (let x = 0; x < N; x++) E[ey + x] += s * K[ky + ((x - x0 + N) % N)]; }
  };
  const tightest = (bits, E) => { let m = -1, mi = 0; for (let i = 0; i < S; i++) if (bits[i] && E[i] > m) { m = E[i]; mi = i; } return mi; };
  const largestVoid = (bits, E) => { let m = Infinity, mi = 0; for (let i = 0; i < S; i++) if (!bits[i] && E[i] < m) { m = E[i]; mi = i; } return mi; };
  // initial pattern, relaxed until stable
  const bits = new Uint8Array(S), E = new Float32Array(S);
  for (let n = 0; n < S * 0.1; ) { const i = (rnd() * S) | 0; if (!bits[i]) { bits[i] = 1; toggle(E, i, 1); n++; } }
  for (let it = 0; it < 4 * S; it++) {
    const c = tightest(bits, E); bits[c] = 0; toggle(E, c, -1);
    const v = largestVoid(bits, E);
    if (v === c) { bits[c] = 1; toggle(E, c, 1); break; }
    bits[v] = 1; toggle(E, v, 1);
  }
  const ones = bits.reduce((a, b) => a + b, 0), rank = new Float32Array(S);
  // phase 1: rank the initial points by removing clusters
  { const b = bits.slice(), e = E.slice(); for (let r = ones - 1; r >= 0; r--) { const c = tightest(b, e); b[c] = 0; toggle(e, c, -1); rank[c] = r; } }
  // phase 2/3: fill voids up to the full set
  { const b = bits.slice(), e = E.slice(); for (let r = ones; r < S; r++) { const v = largestVoid(b, e); b[v] = 1; toggle(e, v, 1); rank[v] = r; } }
  return rank.map((r) => (r + 0.5) / S);
})();
const bn = (x, y) => BN[((y & 63) << 6) | (x & 63)];

/* ================= surfaces ================= */
// Dot colour: ink on paper; on dark paper a dimmer, slightly paper-tinted light so dense areas don't glare.
function dotColor() {
  const ink = rgb(tok("--ink"));
  if (!dark()) return ink;
  const paper = rgb(tok("--paper"));
  return ink.map((v, i) => Math.round(v + (paper[i] - v) * 0.3));
}
// A canvas of w×h dither pixels shown at px CSS px each. cov[i] in [0,1] = how much ink.
function surface(w, h, px) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.style.width = w * px + "px"; c.style.height = h * px + "px";
  c.style.imageRendering = "pixelated";
  const ctx = c.getContext("2d"), img = ctx.createImageData(w, h);
  c.cov = new Float32Array(w * h);
  c.blue = () => { // ordered with blue noise: stable from frame to frame
    const [r, g, b] = dotColor(), d = img.data, cov = c.cov;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const on = cov[i] > bn(x, y), j = i * 4;
      d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = on ? 255 : 0;
    }
    ctx.putImageData(img, 0, 0);
  };
  c.diffuse = () => { // Floyd–Steinberg, serpentine: best for still images
    const [r, g, b] = dotColor(), d = img.data, v = Float32Array.from(c.cov);
    for (let y = 0; y < h; y++) {
      const ltr = y % 2 === 0;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k, i = y * w + x, on = v[i] > 0.5, e = v[i] - (on ? 1 : 0), s = ltr ? 1 : -1;
        if (x + s >= 0 && x + s < w) v[i + s] += e * 7 / 16;
        if (y + 1 < h) {
          if (x - s >= 0 && x - s < w) v[i + w - s] += e * 3 / 16;
          v[i + w] += e * 5 / 16;
          if (x + s >= 0 && x + s < w) v[i + w + s] += e * 1 / 16;
        }
        const j = i * 4; d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = on ? 255 : 0;
      }
    }
    ctx.putImageData(img, 0, 0);
  };
  return c;
}
// ink for a scene luminance L: dark dots on light paper, light dots on dark paper
const inkFor = (L) => (dark() ? L : 1 - L);

/* ================= noise ================= */
const hash2 = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, o = 4) => { let s = 0, a = 0.5, f = 1, n = 0; for (let i = 0; i < o; i++) { s += a * vnoise(x * f + i * 17.3, y * f - i * 9.1); n += a; a *= 0.5; f *= 2.03; } return s / n; };

/* ================= frame loop bookkeeping ================= */
let stops = [];
function loop(frame, fps) {
  if (reduceMotion) { frame(performance.now() / 1000, true); return; }
  let id, last = 0;
  const tick = (t) => { id = requestAnimationFrame(tick); if (t - last >= 1000 / fps - 2) { last = t; frame(t / 1000, false); } };
  id = requestAnimationFrame(tick);
  stops.push(() => cancelAnimationFrame(id));
}
function hero(heightPx, caption) {
  const el = document.createElement("figure");
  el.className = "s s-hero";
  document.querySelector(".index").before(el);
  const w = Math.floor(el.getBoundingClientRect().width), h = heightPx;
  const c = surface(w, h, 1);  // one dither pixel per CSS pixel (2×2 device pixels on retina)
  el.append(c);
  if (caption) { const cap = document.createElement("figcaption"); el.append(cap); c.caption = cap; }
  // soft edges: the picture fades into the paper instead of sitting in a box
  c.edge = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    c.edge[y * w + x] = smooth(0, 0.08, x / w) * smooth(0, 0.08, 1 - x / w) * smooth(0, 0.18, y / h) * smooth(0, 0.12, 1 - y / h);
  return c;
}
// bilinear lookup into a half-resolution buffer
function upsample(buf, w2, h2, x, y) {
  x = clamp(x, 0, w2 - 1.001); y = clamp(y, 0, h2 - 1.001);
  const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * w2 + xi;
  return mix(mix(buf[i], buf[i + 1], fx), mix(buf[i + w2], buf[i + w2 + 1], fx), fy);
}

/* ================= the sky over Copenhagen: one shared state for the window and the plates ================= */
const LAT = 55.68 * Math.PI / 180, LON = 12.57;
const wrapHA = (ha) => Math.atan2(Math.sin(ha), Math.cos(ha));
function cphNow() {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const hour = +parts.hour + parts.minute / 60 + parts.second / 3600;
  const utc = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
  const doy = Math.floor((Date.UTC(+parts.year, parts.month - 1, +parts.day) - Date.UTC(+parts.year, 0, 0)) / 864e5);
  return { now, hour, offset: ((hour - utc + 36) % 24) - 12, doy };
}
// Everything about the light at a given hour today (or right now when hour is null).
function skyAt(hour) {
  const c = cphNow(), h = hour ?? c.hour, utc = h - c.offset;
  const decl = 23.44 * Math.PI / 180 * Math.sin(2 * Math.PI * (284 + c.doy) / 365);
  const elev = (ha) => Math.asin(Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(ha)) * 180 / Math.PI;
  const sunHA = wrapHA((utc + LON / 15 - 12) * 15 * Math.PI / 180);
  // the moon: phase from a known new moon, trailing the sun by phase × 360° (and drifting through the scrubbed day)
  const days = c.now.getTime() / 864e5 + (h - c.hour) / 24;
  const phase = (((days - 10962.76) % 29.530588) + 29.530588) % 29.530588 / 29.530588;
  const moonHA = wrapHA(sunHA - phase * 2 * Math.PI);
  const sun = { ha: sunHA, el: elev(sunHA) }, moon = { ha: moonHA, el: elev(moonHA), phase, lit: (1 - Math.cos(2 * Math.PI * phase)) / 2 };
  const day = smooth(-7, 8, sun.el), twilight = smooth(-14, -2, sun.el) * (1 - smooth(2, 14, sun.el));
  sun.vis = smooth(-3, 1, sun.el);
  moon.vis = smooth(-4, 3, moon.el) * (1 - smooth(0.15, 0.55, day)) * smooth(0.04, 0.2, moon.lit);
  // one light for everything: the sun by day, the moon by night, ambient from the sky
  const src = sun.vis > 0.02 ? sun : moon, strength = sun.vis > 0.02 ? 0.45 * sun.vis + 0.25 * twilight : 0.35 * moon.vis * moon.lit;
  const el = Math.max(src.el, 3) * Math.PI / 180, az = src.ha;
  const L = [Math.sin(az) * Math.cos(el), -0.45 * Math.cos(el), Math.sin(el) + 0.15];
  const m = Math.hypot(...L);
  return { hour: h, live: hour == null, sun, moon, day, twilight, light: { dir: L.map((v) => v / m), strength, ambient: mix(0.05, 0.62, day) + 0.12 * twilight } };
}
// ink coverage for a luminance: the same tone curve everywhere so the window and the plates match
const toneInk = (L, isDark) => {
  if (isDark) { const v = 0.9 * Math.pow(clamp(L), 1.4); return v < 0.5 ? v : 0.5 + (v - 0.5) * 0.6; }
  // on paper, the darkest tones are compressed so night reads as a dark print, not a black slab
  const v = Math.pow(1 - clamp(L), 1.4);
  return v < 0.45 ? v : 0.45 + (v - 0.45) * 0.55;
};
const fmtHour = (h) => { h = ((h % 24) + 24) % 24; return `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`; };

/* ================= 1 · Window onto the Øresund ================= */
function drawWindow(c, getSky) {
  const w = c.width, h = c.height, horizon = Math.round(h * 0.66);
  const w2 = Math.ceil(w / 2) + 1, h2 = Math.ceil(h / 2) + 1, Lb = new Float32Array(w2 * h2);
  const stars = [];
  for (let i = 0; i < 220; i++) stars.push([hash2(i, 1.3) * w, hash2(i, 7.7) * horizon * 0.92, hash2(i, 3.1) * 6.28, 0.35 + hash2(i, 9.9) * 0.65]);
  const coast = new Float32Array(w);
  for (let x = 0; x < w; x++) coast[x] = x / w > 0.5 ? (3 + 5 * fbm(x / 80, 3.7, 3)) * smooth(0.5, 0.62, x / w) : 0;
  const top = h * 0.24;
  const posOf = (b) => ({ x: (0.5 + b.ha / (Math.PI * 1.25)) * w, y: Math.max(top, horizon - clamp(b.el, -10, 40) / 40 * (horizon - top)) });
  const MR = 8.5; // moon radius in pixels

  return (t) => {
    const S = getSky(), { sun, moon, day, twilight } = S, isDark = dark();
    const sp = posOf(sun), mp = posOf(moon);
    const moonGlow = moon.vis * moon.lit;
    // the soft parts (sky, clouds, sea) at half resolution
    for (let y2 = 0; y2 < h2; y2++) for (let x2 = 0; x2 < w2; x2++) {
      const x = x2 * 2, y = y2 * 2;
      let L;
      if (y < horizon) {
        const fy = y / horizon;
        const city = 0.1 * Math.exp(-Math.pow((1 - fy) * 5, 2)) * (0.6 + 0.4 * smooth(0.35, 0.9, x / w));
        L = mix(0.07 + 0.1 * fy * fy + city, mix(0.72, 0.93, fy * fy), day);
        const dsx = (x - sp.x) / w;
        L += twilight * 0.6 * Math.exp(-dsx * dsx / 0.06) * Math.pow(fy, 2.2);
        const n = fbm(x / 120 + t * 0.008, y / 34, 4), cl = smooth(0.5, 0.78, n) * (0.3 + 0.7 * fy);
        // clouds: bright by day, dark shapes at night, faintly silvered when the moon is up
        L = mix(L, mix(mix(0.12, 0.55, twilight) + 0.12 * moonGlow, 0.99, smooth(0.15, 0.45, day)), cl * 0.85);
        { const d = Math.hypot(x - sp.x, y - sp.y); L += 0.3 * Math.exp(-(d * d) / 450) * (0.4 + 0.6 * day) * sun.vis; }
        { const d = Math.hypot(x - mp.x, y - mp.y); L += 0.16 * moonGlow * Math.exp(-(d * d) / 1100); }
      } else {
        const depth = (y - horizon) / (h - horizon);
        L = mix(0.08 + 0.05 * depth + 0.06 * Math.exp(-depth * 6), mix(0.56, 0.7, depth), day) + twilight * 0.18 * (1 - depth);
        L = Math.max(0, L + (vnoise(x / (26 + depth * 50), y * 0.55 - t * 0.35) - 0.5) * 0.2 * (0.4 + depth) * (0.35 + 0.65 * day));
        // glitter path under the sun, or under the moon (as bright as the moon is full)
        const spark = vnoise(x / 4 + t * 0.6, y * 0.9 - t * 1.6) > 0.6;
        if (spark) {
          const g = (src) => Math.exp(-Math.pow((x - src.x) / (10 + depth * 60), 2));
          L = mix(L, 1, Math.max(g(sp) * sun.vis, g(mp) * 0.75 * moonGlow));
        }
      }
      Lb[y2 * w2 + x2] = clamp(L);
    }
    // crisp parts at full resolution, then tone to ink
    const cov = c.cov, edge = c.edge;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // on dark paper the scene is exposed down, so the sun and moon still stand out against a bright sky
      let L = upsample(Lb, w2, h2, x / 2, y / 2) * (isDark ? mix(0.9, 0.7, day) : 1);
      if (y < horizon) {
        // sun: a soft-edged disc that fades in as it clears the horizon
        if (sun.vis > 0) { const d = Math.hypot(x - sp.x, y - sp.y); L = mix(L, 1, sun.vis * (1 - smooth(8, 9.5, d))); }
        // moon: only the lit part is drawn, with a soft terminator and a soft limb; fades in and out
        if (moon.vis > 0) {
          const dx = (x - mp.x) / MR, dy = (y - mp.y) / MR, r2 = dx * dx + dy * dy;
          if (r2 < 1.2) {
            const z = Math.sqrt(Math.max(0, 1 - r2)), a = moon.phase * 2 * Math.PI;
            const lit = smooth(-0.12, 0.12, Math.sin(a) * dx - Math.cos(a) * z);
            const limb = 1 - smooth(0.85, 1.1, Math.sqrt(r2));
            L = mix(L, 0.97 * (0.75 + 0.25 * Math.pow(z, 0.4)), lit * limb * moon.vis);
          }
        }
        if (horizon - y < coast[x]) L = mix(0.05, 0.3, day);
      }
      cov[i] = toneInk(L, isDark) * edge[i];
    }
    // stars, twinkling, where the sky is dark and clear
    const starVis = 1 - smooth(0.05, 0.4, day);
    if (starVis > 0) for (const [sx, sy, ph, b] of stars) {
      const x = sx | 0, y = sy | 0, i = y * w + x;
      if (fbm(sx / 120 + t * 0.008, sy / 34, 4) > 0.52 || Math.hypot(sx - mp.x, sy - mp.y) < MR * 2.5) continue;
      if (starVis * b * (0.6 + 0.4 * Math.sin(t * 1.9 + ph)) > 0.45) c.cov[i] = isDark ? c.edge[i] : 0;
    }
    c.blue();
  };
}

/* ================= 3 · Plates: a figure per post, in the same light as the window ================= */
function strHash(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; }
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Supershapes (Gielis' superformula in 3D): a continuous family of solid shapes (shells, stars, pillows,
// crystals) controlled by a handful of real numbers.
const superR = (ang, m, n1, n2, n3) => Math.pow(Math.pow(Math.abs(Math.cos(m * ang / 4)), n2) + Math.pow(Math.abs(Math.sin(m * ang / 4)), n3), -1 / n1);
function superPoint(P, th, ph) {
  const r1 = superR(th, P[0], P[1], P[2], P[3]), r2 = superR(ph, P[4], P[5], P[6], P[7]);
  return [r1 * Math.cos(th) * r2 * Math.cos(ph), r1 * Math.sin(th) * r2 * Math.cos(ph), r2 * Math.sin(ph)];
}
// The title picks a point in that family: a hash of the title seeds a random generator, which draws the
// parameters and the angle we look from. Spiky, flat or degenerate draws are rejected and it draws again.
function shapeFor(title) {
  const r = rng(strHash(title));
  const logU = (a, b) => Math.exp(Math.log(a) + r() * (Math.log(b) - Math.log(a)));
  for (let tries = 0; tries < 400; tries++) {
    const P = [1 + Math.floor(r() * 10), logU(0.3, 8), logU(0.3, 6), logU(0.3, 6), Math.floor(r() * 8), logU(0.3, 8), logU(0.3, 6), logU(0.3, 6)];
    let ok = true, rmin = 1e9, rmax = 0;
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < 40 && ok; i++) for (let j = 0; j < 20; j++) {
      const q = superPoint(P, -Math.PI + 2 * Math.PI * i / 40, -Math.PI / 2 + Math.PI * (j + 0.5) / 20), rr = Math.hypot(...q);
      if (!isFinite(rr)) { ok = false; break; }
      rmin = Math.min(rmin, rr); rmax = Math.max(rmax, rr);
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[k]); mx[k] = Math.max(mx[k], q[k]); }
    }
    const ext = mx.map((v, k) => v - mn[k]);
    // not a plain sphere, not a spiky mess, not flat
    if (!ok || rmax / rmin < 1.35 || rmax / rmin > 4.5 || Math.min(...ext) < 0.45 * Math.max(...ext)) continue;
    return { P, yaw: r() * 2 * Math.PI, pitch: 0.3 + r() * 0.5 };
  }
  return { P: [6, 1, 1, 1, 3, 1, 1, 1], yaw: 0.5, pitch: 0.5 };
}
// A plate: the post's shape as a solid object, slowly turning, lit by the window's sun or moon.
// The surface is sampled densely with normals, drawn into a depth buffer (near hides far), then shaded.
function makePlate(title, size, developing) {
  const A = shapeFor(title), c = surface(size, size, 1), S = size * size;
  const U = 240, V = 120, NP = U * V, pos = new Float32Array(NP * 3), nrm = new Float32Array(NP * 3);
  const grid = (i, j) => superPoint(A.P, -Math.PI + 2 * Math.PI * ((i + U) % U) / U, -Math.PI / 2 + Math.PI * (clamp(j, 0, V - 1) + 0.5) / V);
  let rad = 0;
  for (let i = 0; i < U; i++) for (let j = 0; j < V; j++) {
    const k = (i * V + j) * 3, q = grid(i, j), du = grid(i + 1, j).map((v, d) => v - grid(i - 1, j)[d]), dv = grid(i, j + 1).map((v, d) => v - grid(i, j - 1)[d]);
    let n = [du[1] * dv[2] - du[2] * dv[1], du[2] * dv[0] - du[0] * dv[2], du[0] * dv[1] - du[1] * dv[0]];
    const m = Math.hypot(...n) || 1; n = n.map((v) => v / m);
    if (n[0] * q[0] + n[1] * q[1] + n[2] * q[2] < 0) n = n.map((v) => -v);   // outward
    pos.set(q, k); nrm.set(n, k); rad = Math.max(rad, Math.hypot(...q));
  }
  // a fixed shuffled order, so a still-developing plate materialises evenly rather than row by row
  const order = new Uint32Array(NP).map((_, i) => i), rs = rng(strHash(title + "#order"));
  for (let i = NP - 1; i > 0; i--) { const j = Math.floor(rs() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const zb = new Float32Array(S), nb = new Float32Array(S * 3), hit = new Uint8Array(S);
  const born = performance.now();
  c.update = (S0, t) => {
    const count = developing ? Math.round(NP * smooth(0, 1, (performance.now() - born) / 30000) ** 0.8) + 600 : NP;
    const yaw = A.yaw + (reduceMotion ? 0 : t * 0.05), cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(A.pitch), sp = Math.sin(A.pitch);
    const half = size / 2, scale = half * 0.9 / rad;
    zb.fill(-1e9); hit.fill(0);
    const rot = (x, y, z) => { const x1 = x * cy + y * sy, y1 = -x * sy + y * cy; return [x1, z * cp - y1 * sp, z * sp + y1 * cp]; }; // spin about the shape's axis, then tilt
    for (let o = 0; o < count; o++) {
      const k = order[o] * 3, [X, Y, Z] = rot(pos[k], pos[k + 1], pos[k + 2]);
      const px = (half + X * scale) | 0, py = (half - Y * scale) | 0;
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      const i = py * size + px;
      if (Z > zb[i]) { zb[i] = Z; hit[i] = 1; const [nx, ny, nz] = rot(nrm[k], nrm[k + 1], nrm[k + 2]); nb[i * 3] = nx; nb[i * 3 + 1] = -ny; nb[i * 3 + 2] = nz; }
    }
    const { dir, strength } = S0.light, isDark = dark();
    const base = mix(0.3, 0.6, S0.day) + 0.1 * S0.twilight;
    const hx = dir[0], hy = dir[1], hz = dir[2] + 1, hm = Math.hypot(hx, hy, hz);  // half-vector for a small highlight
    for (let i = 0; i < S; i++) {
      if (!hit[i]) { c.cov[i] = 0; continue; }
      const nx = nb[i * 3], ny = nb[i * 3 + 1], nz = nb[i * 3 + 2];
      const diff = Math.max(0, nx * dir[0] + ny * dir[1] + nz * dir[2]);
      const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hm), 24) * strength;
      const Lf = clamp(base * 0.45 + (0.25 + 1.6 * strength) * diff + 0.8 * spec);
      c.cov[i] = isDark ? 0.05 + 0.85 * Lf : 0.06 + 0.9 * (1 - Lf);
    }
    c.blue();
  };
  return c;
}

/* ================= social icons: plain, crisp marks (no dithering) ================= */
const ICONS = {
  github: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg>`,
  x: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
  // Hugging Face mark from Simple Icons (CC0)
  huggingface: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M1.4446 11.5059c0 1.1021.1673 2.1585.4847 3.1563-.0378-.0028-.0691-.0058-.1058-.0058-.4209 0-.8015.16-1.0704.4512-.3454.3737-.4984.8335-.4316 1.293a1.576 1.576 0 0 0 .2148.5978c-.2319.1864-.4018.4456-.4844.7578-.0646.2448-.131.7543.2149 1.2794a1.4552 1.4552 0 0 0-.0625.1055c-.208.3923-.2207.8372-.0371 1.25.2783.6258.9696 1.1175 2.3126 1.6467.8356.3292 1.5988.5411 1.6056.543 1.1046.2847 2.104.4277 2.969.4277 1.4173 0 2.4754-.3849 3.1525-1.1446 1.538.2651 2.791.1403 3.592.006.6773.7555 1.7332 1.1387 3.1467 1.1387.8649 0 1.8643-.143 2.969-.4278.0068-.0019.77-.2138 1.6056-.543 1.343-.5292 2.0343-1.0208 2.3126-1.6466.1836-.4129.171-.8577-.037-1.25a1.4685 1.4685 0 0 0-.0626-.1056c.346-.525.2795-1.0346.2149-1.2793-.0826-.3122-.2525-.5714-.4844-.7579.11-.1816.1831-.3788.2148-.5977.0669-.4595-.0862-.9193-.4316-1.293-.2688-.2913-.6495-.4513-1.0704-.4513-.0209 0-.0376.0008-.0588.0018.3162-.9966.4846-2.0518.4846-3.1523 0-5.807-4.7362-10.5144-10.5789-10.5144-5.8426 0-10.5788 4.7073-10.5788 10.5144Zm10.5788-9.4831c5.2727 0 9.5476 4.246 9.5476 9.483a9.4201 9.4201 0 0 1-.2696 2.2365c-.0039-.0047-.0079-.011-.0117-.0156-.274-.3255-.6679-.5059-1.1075-.5059-.352 0-.714.1155-1.0763.3438-.2403.1517-.5058.422-.7793.7598-.2534-.3492-.608-.5832-1.0137-.6465a1.5174 1.5174 0 0 0-.2344-.0176c-.9263 0-1.4828.7993-1.6935 1.5177-.1046.2426-.6065 1.3482-1.3614 2.0978-1.1681 1.1601-1.4458 2.3534-.8396 3.6382-.843.1029-1.5836.0927-2.365-.006.5906-1.212.3626-2.4388-.8426-3.6322-.755-.7496-1.2568-1.8552-1.3614-2.0978-.2107-.7184-.7673-1.5177-1.6935-1.5177-.078 0-.1568.0054-.2344.0176-.4057.0633-.7604.2973-1.0137.6465-.2735-.3379-.539-.6081-.7794-.7598-.3622-.2283-.7243-.3438-1.0762-.3438-.4266 0-.8094.171-1.0821.4786a9.4208 9.4208 0 0 1-.2598-2.1936c0-5.237 4.2749-9.483 9.5475-9.483zM8.6443 7.0036c-.4838.0043-.9503.2667-1.1934.7227-.3536.6633-.1006 1.4873.5645 1.84.351.1862.4883-.5261.836-.6485.3107-.1095.841.399 1.0078.086.3536-.6634.1025-1.4874-.5625-1.84a1.3659 1.3659 0 0 0-.6524-.1602Zm6.8403 0c-.2199-.002-.4426.05-.6504.1602-.665.3526-.9181 1.1766-.5645 1.84.1669.313.6971-.1955 1.0079-.086.3476.1224.4867.8347.838.6485.6649-.3527.916-1.1767.5624-1.84-.243-.456-.7096-.7184-1.1934-.7227Zm-9.7565 1.418a.8768.8768 0 0 0-.877.877c0 .4846.3925.877.877.877a.8768.8768 0 0 0 .877-.877.8768.8768 0 0 0-.877-.877zm12.6434 0c-.4845 0-.879.3925-.879.877 0 .4846.3945.877.879.877a.8768.8768 0 0 0 .877-.877.8768.8768 0 0 0-.877-.877zM8.7927 11.459c-.179-.003-.2793.1107-.2793.416 0 .8097.3874 2.125 1.4279 2.924.207-.7123 1.3453-1.2832 1.5079-1.2012.2315.1167.2191.4417.6074.7266.3884-.285.374-.6098.6056-.7266.1627-.082 1.3009.4889 1.5079 1.2012 1.0404-.799 1.4278-2.1144 1.4278-2.924 0-1.2212-1.583.6402-3.5413.6485-1.4686-.0061-2.7266-1.0558-3.2639-1.0645zM4.312 14.4768c.5792.365 1.6964 2.2751 2.1056 3.0177.1371.2488.371.3536.582.3536.4188 0 .7465-.4138.0391-.9395-1.0636-.791-.6914-2.0846-.1836-2.1642a.4302.4302 0 0 1 .0664-.004c.4616 0 .666.7892.666.7892s.5959 1.4898 1.6213 2.508c.942.9356 1.062 1.703.4961 2.6661-.0164-.004-.0159.0236-.1484.2149-.1853.2673-.4322.4688-.7188.6152-.5062.2269-1.1397.2696-1.7833.2696-1.037 0-2.1017-.1824-2.6975-.336-.0293-.0075-3.6505-.9567-3.1916-1.8224.0771-.1454.2033-.2031.3633-.2031.6463 0 1.823.9551 2.3283.9551.113 0 .196-.0865.2285-.2031.2249-.8045-3.2787-1.0522-2.9846-2.1642.0519-.1967.193-.2757.3907-.2754.854 0 2.7704 1.4923 3.172 1.4923.0307 0 .0525-.0085.0645-.0274.2012-.3227.1096-.5865-1.3087-1.4395-1.4182-.8533-2.4315-1.329-1.8653-1.9416.0651-.0707.1574-.1015.2695-.1015.8611.0002 2.8948 1.84 2.8948 1.84s.5487.5683.8809.5683c.0762 0 .1416-.0315.1855-.1054.2355-.3946-2.1858-2.2183-2.3224-2.971-.0926-.51.0641-.7676.3555-.7676-.0006.008.1701-.0285.4942.1759zm16.2257.5918c-.1366.7526-2.5579 2.5764-2.3224 2.9709.044.074.1092.1055.1855.1055.3321 0 .881-.5684.881-.5684s2.0336-1.8397 2.8947-1.84c.1121 0 .2044.0308.2695.1016.5662.6125-.447 1.0882-1.8653 1.9415-1.4183.853-1.51 1.1168-1.3087 1.4396.012.0188.0337.0273.0644.0273.4016 0 2.3181-1.4923 3.1721-1.4923.1977-.0002.3388.0787.3907.2754.294 1.112-3.2095 1.3597-2.9846 2.1642.0325.1166.1156.2032.2285.2032.5054 0 1.682-.9552 2.3283-.9552.16 0 .2862.0577.3633.2032.459.8656-3.1623 1.8149-3.1916 1.8224-.5958.1535-1.6605.336-2.6975.336-.6351 0-1.261-.0409-1.7638-.2599-.2949-.1472-.5488-.3516-.7383-.625-.0411-.0682-.1026-.1476-.1426-.205-.5726-.9679-.455-1.7371.4903-2.676 1.0254-1.0182 1.6212-2.508 1.6212-2.508s.2044-.7891.666-.7891a.4318.4318 0 0 1 .0665.0039c.5078.0796.88 1.3732-.1836 2.1642-.7074.5257-.3797.9395.039.9395.211 0 .445-.1047.5821-.3535.4092-.7426 1.5264-2.6527 2.1056-3.0178.5588-.3524.99-.1816.8497.5918z"/></svg>`,
};
const iconFor = (title) => (/github/i.test(title) ? "github" : /^x\b/i.test(title.trim()) ? "x" : /hugging/i.test(title) ? "huggingface" : null);

/* ================= 1 + 3 · the window with a time slider, and plates in the Writing list ================= */
function sampleSky() {
  const fig = document.createElement("figure");
  fig.className = "s s-hero sky";
  document.querySelector(".index").before(fig);
  const w = Math.floor(fig.getBoundingClientRect().width), h = 250;
  const c = surface(w, h, 1);
  c.edge = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c.edge[y * w + x] = smooth(0, 0.08, x / w) * smooth(0, 0.08, 1 - x / w) * smooth(0, 0.18, y / h) * smooth(0, 0.12, 1 - y / h);
  fig.append(c);
  fig.insertAdjacentHTML("beforeend", `
    <div class="sky-time">
      <input type="range" min="0" max="24" step="0.05" aria-label="Time of day">
      <span class="sky-nowmark" aria-hidden="true"></span>
      <div class="sky-ticks" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    </div>
    <figcaption><button class="sky-back" hidden>Back to now</button></figcaption>`);
  const slider = fig.querySelector("input"), mark = fig.querySelector(".sky-nowmark"), back = fig.querySelector(".sky-back");
  let override = null, state = skyAt(null);
  let lastInput = 0;
  slider.addEventListener("input", () => { override = +slider.value; lastInput = performance.now(); if (reduceMotion) render(performance.now() / 1000); });
  back.addEventListener("click", () => { override = null; if (reduceMotion) render(performance.now() / 1000); });

  // plates for every row in Writing
  const plates = [];
  document.querySelectorAll(".index section:first-child .list li").forEach((li) => {
    const row = li.querySelector(".row");
    if (!row) return;
    const p = makePlate(row.querySelector(".title").textContent.trim(), 72, row.tagName === "SPAN");
    p.classList.add("s", "s-plate");
    row.prepend(p);
    row.classList.add("s-row");
    plates.push(p);
  });
  // plain icons next to the social links
  document.querySelectorAll(".index-side section:last-child .list a").forEach((a) => {
    const kind = iconFor(a.querySelector(".title").textContent);
    if (!kind) return;
    a.insertAdjacentHTML("afterbegin", `<span class="s s-icon">${ICONS[kind]}</span>`);
    a.classList.add("s-social");
  });

  const window_ = drawWindow(c, () => state);
  function render(t) {
    state = skyAt(override);
    if (override == null && document.activeElement !== slider) slider.value = state.hour;
    const nowHour = cphNow().hour;
    mark.style.left = `calc(6px + (100% - 12px) * ${nowHour / 24})`;
    mark.hidden = override == null;
    back.hidden = override == null;
    slider.setAttribute("aria-valuetext", `${fmtHour(state.hour)}${override == null ? ", now" : ""}`);
    window_(t);
    // the plates need not redraw every frame unless the time is being scrubbed
    plates.forEach((p) => p.update(state, t));
  }
  loop(render, 15);
}

/* ================= 2 · Relief: a terrain lit by your cursor ================= */
function sampleRelief() {
  const c = hero(250, true), w = c.width, h = c.height;
  c.caption.textContent = "Terrain and contours, lit from wherever your pointer is";
  const w2 = Math.ceil(w / 2) + 1, h2 = Math.ceil(h / 2) + 1, S2 = w2 * h2;
  const H = new Float32Array(S2), N = new Float32Array(S2 * 3), C = new Float32Array(S2), shade = new Float32Array(S2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const s = 1 / 120, qx = fbm(x * s, y * s, 3), qy = fbm(x * s + 5.2, y * s + 1.3, 3);
    H[y * w2 + x] = fbm(x * s + 1.4 * qx, y * s + 1.4 * qy, 4);
  }
  const LEVELS = 14;
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const i = y * w2 + x, hx = (H[y * w2 + Math.min(w2 - 1, x + 1)] - H[y * w2 + Math.max(0, x - 1)]) / 2, hy = (H[Math.min(h2 - 1, y + 1) * w2 + x] - H[Math.max(0, y - 1) * w2 + x]) / 2;
    const nx = -hx * 70, ny = -hy * 70, m = Math.hypot(nx, ny, 1);
    N[i * 3] = nx / m; N[i * 3 + 1] = ny / m; N[i * 3 + 2] = 1 / m;
    // contour lines of constant on-screen width: distance to the nearest level, divided by the slope
    const f = H[i] * LEVELS, dist = Math.abs(f - Math.round(f)), slope = Math.hypot(hx, hy) * LEVELS + 1e-6;
    C[i] = 1 - smooth(0.25, 0.9, dist / slope);
  }
  const light = { x: w2 * 0.3, y: -h2 * 0.3, tx: w2 * 0.3, ty: -h2 * 0.3, idle: 0 };
  const onMove = (e) => {
    const r = c.getBoundingClientRect();
    light.tx = (e.clientX - r.left) / 2; light.ty = (e.clientY - r.top) / 2; light.idle = performance.now();
  };
  addEventListener("pointermove", onMove);
  stops.push(() => removeEventListener("pointermove", onMove));
  loop((t) => {
    if (performance.now() - light.idle > 2500) { light.tx = w2 * (0.5 + 0.45 * Math.cos(t * 0.22)); light.ty = h2 * (0.5 + 0.8 * Math.sin(t * 0.22)); }
    light.x = mix(light.x, light.tx, 0.14); light.y = mix(light.y, light.ty, 0.14);
    const lz = 40, isDark = dark();
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      const i = y * w2 + x, dx = light.x - x, dy = light.y - y, d = Math.hypot(dx, dy, lz);
      const diff = Math.max(0, (N[i * 3] * dx + N[i * 3 + 1] * dy + N[i * 3 + 2] * lz) / d);
      const att = 1 / (1 + (dx * dx + dy * dy) / (w2 * w2 * 0.06));
      const sh = Math.pow(diff, 1.5) * att;
      // light paper: ink gathers in the shadows; dark paper: the lit slopes glow. Contours either way.
      shade[i] = isDark ? 0.6 * Math.pow(sh, 1.3) + 0.55 * C[i] * (0.35 + 0.65 * sh) : 0.3 * Math.pow(1 - sh, 2) + 0.6 * C[i] * (0.4 + 0.6 * (1 - sh));
    }
    const cov = c.cov, edge = c.edge;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; cov[i] = clamp(upsample(shade, w2, h2, x / 2, y / 2)) * edge[i]; }
    c.blue();
  }, 30);
}

/* ================= 4 · Ink: a small fluid you can stir ================= */
function sampleInk() {
  const c = hero(250, true), w = c.width, h = c.height;
  c.caption.textContent = "Ink in water. Move through it to stir";
  const NX = 128, NY = Math.max(16, Math.round(NX * h / w)), S = NX * NY, I = (x, y) => y * NX + x;
  const DX = NX * 3, DY = NY * 3, DS = DX * DY;  // the ink lives on a finer grid than the flow
  let u = new Float32Array(S), v = new Float32Array(S), u0 = new Float32Array(S), v0 = new Float32Array(S);
  let dye = new Float32Array(DS), dye0 = new Float32Array(DS);
  const p = new Float32Array(S), div = new Float32Array(S), curl = new Float32Array(S);
  const sample = (f, fw, fh, x, y) => {
    x = clamp(x, 0, fw - 1.001); y = clamp(y, 0, fh - 1.001);
    const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, i = yi * fw + xi;
    return mix(mix(f[i], f[i + 1], fx), mix(f[i + fw], f[i + fw + 1], fx), fy);
  };
  const advect = (dst, src, dt) => { for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) { const i = I(x, y); dst[i] = sample(src, NX, NY, x - dt * u[i], y - dt * v[i]); } };
  const advectDye = (dt) => {
    for (let y = 0; y < DY; y++) for (let x = 0; x < DX; x++) {
      const gx = (x + 0.5) / 3 - 0.5, gy = (y + 0.5) / 3 - 0.5;
      const vx = sample(u, NX, NY, gx, gy) * 3, vy = sample(v, NX, NY, gx, gy) * 3;
      dye0[y * DX + x] = sample(dye, DX, DY, x - dt * vx, y - dt * vy) * 0.992;
    }
    [dye, dye0] = [dye0, dye];
  };
  const splat = (cx, cy, fx, fy, amount, r) => {
    for (let y = Math.max(0, (cy - 3 * r) | 0); y < Math.min(NY, cy + 3 * r); y++) for (let x = Math.max(0, (cx - 3 * r) | 0); x < Math.min(NX, cx + 3 * r); x++) {
      const g = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r)), i = I(x, y); u[i] += fx * g; v[i] += fy * g;
    }
    const R = r * 3 * 0.55, X = cx * 3, Y = cy * 3;
    for (let y = Math.max(0, (Y - 3 * R) | 0); y < Math.min(DY, Y + 3 * R); y++) for (let x = Math.max(0, (X - 3 * R) | 0); x < Math.min(DX, X + 3 * R); x++) {
      const g = Math.exp(-((x - X) ** 2 + (y - Y) ** 2) / (2 * R * R)), i = y * DX + x; dye[i] = Math.min(2.5, dye[i] + amount * g);
    }
  };
  function step(dt) {
    for (let y = 1; y < NY - 1; y++) for (let x = 1; x < NX - 1; x++) curl[I(x, y)] = (v[I(x + 1, y)] - v[I(x - 1, y)] - u[I(x, y + 1)] + u[I(x, y - 1)]) * 0.5;
    for (let y = 2; y < NY - 2; y++) for (let x = 2; x < NX - 2; x++) {
      const i = I(x, y), gx = Math.abs(curl[I(x + 1, y)]) - Math.abs(curl[I(x - 1, y)]), gy = Math.abs(curl[I(x, y + 1)]) - Math.abs(curl[I(x, y - 1)]), m = Math.hypot(gx, gy) + 1e-5;
      u[i] += dt * 1.2 * (gy / m) * curl[i]; v[i] -= dt * 1.2 * (gx / m) * curl[i];
    }
    for (let y = 1; y < NY - 1; y++) for (let x = 1; x < NX - 1; x++) { const i = I(x, y); div[i] = -0.5 * (u[I(x + 1, y)] - u[I(x - 1, y)] + v[I(x, y + 1)] - v[I(x, y - 1)]); p[i] = 0; }
    for (let k = 0; k < 24; k++) for (let y = 1; y < NY - 1; y++) for (let x = 1; x < NX - 1; x++) { const i = I(x, y); p[i] = (div[i] + p[I(x - 1, y)] + p[I(x + 1, y)] + p[I(x, y - 1)] + p[I(x, y + 1)]) / 4; }
    for (let y = 1; y < NY - 1; y++) for (let x = 1; x < NX - 1; x++) { const i = I(x, y); u[i] -= 0.5 * (p[I(x + 1, y)] - p[I(x - 1, y)]); v[i] -= 0.5 * (p[I(x, y + 1)] - p[I(x, y - 1)]); }
    for (let x = 0; x < NX; x++) { v[I(x, 0)] = v[I(x, NY - 1)] = 0; }
    for (let y = 0; y < NY; y++) { u[I(0, y)] = u[I(NX - 1, y)] = 0; }
    advect(u0, u, dt); advect(v0, v, dt); [u, u0] = [u0, u]; [v, v0] = [v0, v];
    for (let i = 0; i < S; i++) { u[i] = clamp(u[i] * 0.996, -3, 3); v[i] = clamp(v[i] * 0.996, -3, 3); }
    advectDye(dt);
  }
  // a few slow wanderers keep it going when nobody is stirring
  const K = [1, 1.6, 2.3];
  const wander = (t, k) => [NX * (0.5 + 0.4 * Math.sin(t * 0.21 * k + k * 2)), NY * (0.5 + 0.34 * Math.sin(t * 0.29 * k + 3 * k))];
  let prev = K.map((k) => wander(0, k)), ptr = null, lastPtr = 0;
  const feed = (t) => K.forEach((k, j) => { const q = wander(t, k), [px, py] = prev[j]; splat(q[0], q[1], (q[0] - px) * 5, (q[1] - py) * 5, 0.5, 1.1); prev[j] = q; });
  const onMove = (e) => {
    const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * NX, y = (e.clientY - r.top) / r.height * NY;
    if (ptr && x > -4 && x < NX + 4 && y > -4 && y < NY + 4) splat(x, y, (x - ptr[0]) * 2.5, (y - ptr[1]) * 2.5, 0.9, 1.6);
    ptr = [x, y]; lastPtr = performance.now();
  };
  addEventListener("pointermove", onMove);
  stops.push(() => removeEventListener("pointermove", onMove));
  // start mid-swirl rather than from clear water
  for (let k = 0; k < 160; k++) { feed(k / 30); step(1); }
  loop((t) => {
    if (performance.now() - lastPtr > 3000) feed(t);
    step(1);
    const cov = c.cov, edge = c.edge;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = sample(dye, DX, DY, (x + 0.5) / w * DX - 0.5, (y + 0.5) / h * DY - 0.5);
      cov[y * w + x] = (1 - Math.exp(-d * 1.5)) * 0.95 * edge[y * w + x];
    }
    c.blue();
  }, 30);
}

/* ================= switching ================= */
const samples = { sky: sampleSky, relief: sampleRelief, ink: sampleInk };
function apply() {
  stops.forEach((f) => f()); stops = [];
  document.querySelectorAll(".s").forEach((el) => el.remove());
  document.querySelectorAll(".s-row, .s-social").forEach((el) => el.classList.remove("s-row", "s-social"));
  const v = root.dataset.sample;
  root.setAttribute("data-hero", "");
  document.querySelectorAll(".sw button[data-v]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v));
  history.replaceState(null, "", "#" + v);
  samples[v]();
}

const style = document.createElement("style");
style.textContent = `
  html[data-hero] .index { margin-top: 3.25rem; }
  .s-hero { margin: 4.5rem 0 0; }
  .s-hero canvas { display: block; }
  .s-hero figcaption { display: flex; justify-content: flex-end; gap: 1rem; min-height: 1.2em; margin-top: .35rem; font-size: .78rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .sky-back { color: var(--muted); font-size: inherit; }
  .sky-back:hover { color: var(--ink); }

  /* time slider: a hairline timeline under the picture */
  .sky-time { position: relative; margin-top: .4rem; }
  .sky-time input { display: block; width: 100%; height: 18px; margin: 0; background: none; cursor: pointer; -webkit-appearance: none; appearance: none; }
  .sky-time input::-webkit-slider-runnable-track { height: 1px; background: var(--line); }
  .sky-time input::-moz-range-track { height: 1px; background: var(--line); }
  .sky-time input::-webkit-slider-thumb { -webkit-appearance: none; width: 11px; height: 11px; margin-top: -5px; border-radius: 50%; background: var(--ink); border: 2px solid var(--paper); box-shadow: 0 0 0 1px var(--ink); }
  .sky-time input::-moz-range-thumb { width: 9px; height: 9px; border-radius: 50%; background: var(--ink); border: 2px solid var(--paper); box-shadow: 0 0 0 1px var(--ink); }
  .sky-time input:focus-visible { outline: none; }
  .sky-time input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 1px var(--ink), 0 0 0 4px var(--accent-soft); }
  .sky-nowmark { position: absolute; top: 5px; width: 1px; height: 8px; background: var(--muted); pointer-events: none; }
  .sky-ticks { display: flex; justify-content: space-between; padding: 0 2px; font-size: .68rem; color: var(--muted); font-variant-numeric: tabular-nums; }

  .list .s-row { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; align-items: center; gap: 1.1rem; }
  .s-plate { display: block; }
  .list .s-social { display: grid; grid-template-columns: 22px minmax(0, 1fr); column-gap: .85rem; align-items: center; }
  .list .s-social .s-icon { grid-row: span 2; display: block; width: 22px; height: 22px; color: var(--ink); }
  .list .s-social .s-icon svg { display: block; width: 100%; height: 100%; }
  .list .s-social:hover .s-icon { color: var(--accent); }
  .sw { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 50; display: flex; align-items: center; gap: 4px; padding: 5px;
    border-radius: 999px; background: rgba(20,20,20,.88); font: 500 13px/1 system-ui, sans-serif; color: #bbb; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
  .sw button { all: unset; cursor: pointer; padding: 8px 12px; border-radius: 999px; white-space: nowrap; }
  .sw button:hover { color: #fff; }
  .sw button[aria-pressed="true"] { background: #fff; color: #111; }
`;
document.head.append(style);

const bar = document.createElement("div");
bar.className = "sw";
bar.innerHTML = [["sky", "Window + plates"], ["relief", "Relief"], ["ink", "Ink"]].map(([v, n]) => `<button data-v="${v}">${n}</button>`).join("");
document.body.append(bar);
bar.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { root.dataset.sample = b.dataset.v; apply(); } });
let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(apply, 200); });

root.dataset.sample = ["sky", "relief", "ink"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "sky";
document.fonts.ready.then(apply);
