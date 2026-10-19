// The home page's dithered pictures: a live view of the sky over the Øresund (the real sun and moon for
// Copenhagen right now), and a small lit 3D figure for each post, chosen by its title and lit by the same sky.
// Two tones only, ordered dithering with a blue-noise threshold map. No dependencies.
(() => {
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
  return c;
}

/* ================= noise ================= */
const hash2 = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, o = 4) => { let s = 0, a = 0.5, f = 1, n = 0; for (let i = 0; i < o; i++) { s += a * vnoise(x * f + i * 17.3, y * f - i * 9.1); n += a; a *= 0.5; f *= 2.03; } return s / n; };

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

/* ================= the home page: the view, and a plate for each post ================= */
const fig = document.querySelector(".sky");
const plateEls = [...document.querySelectorAll(".plate[data-seed]")];
if (!fig && !plateEls.length) return;
let override = null;        // an hour picked on the slider, or null for now
let view = null, drawView = null, slider = null, back = null, mark = null;

function buildView() {
  const holder = fig.querySelector(".sky-view");
  holder.replaceChildren();
  // on wider screens the view takes whatever height is left in the window (180–250px), so the page doesn't scroll
  holder.style.height = "";
  if (matchMedia("(min-width: 640px)").matches) {
    const rest = document.documentElement.scrollHeight - holder.clientHeight;
    holder.style.height = `${Math.round(clamp(innerHeight - rest, 180, 250))}px`;
  }
  const w = Math.floor(holder.clientWidth), h = Math.floor(holder.clientHeight);
  if (!w || !h) return;
  view = surface(w, h, 1);  // one dot per CSS pixel (2×2 device pixels on retina)
  // soft edges: the picture fades into the paper instead of sitting in a box
  view.edge = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    view.edge[y * w + x] = smooth(0, 0.08, x / w) * smooth(0, 0.08, 1 - x / w) * smooth(0, 0.18, y / h) * smooth(0, 0.12, 1 - y / h);
  holder.append(view);
  drawView = drawWindow(view, () => state);
}
if (fig) {
  buildView();
  // the time-of-day slider, shown only when config.yml asks for it (sky: slider: true)
  if (fig.hasAttribute("data-slider")) {
    fig.insertAdjacentHTML("beforeend", `
      <div class="sky-time">
        <input type="range" min="0" max="24" step="0.05" aria-label="Time of day">
        <span class="sky-nowmark" aria-hidden="true" hidden></span>
        <div class="sky-ticks" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      </div>
      <div class="sky-foot"><button class="sky-back" hidden>Back to now</button></div>`);
    slider = fig.querySelector(".sky-time input"); mark = fig.querySelector(".sky-nowmark"); back = fig.querySelector(".sky-back");
    slider.addEventListener("input", () => { override = +slider.value; if (reduceMotion) render(performance.now() / 1000); });
    back.addEventListener("click", () => { override = null; if (reduceMotion) render(performance.now() / 1000); });
  }
}
const plates = plateEls.map((el) => {
  const p = makePlate(el.dataset.seed, 72, el.hasAttribute("data-developing"));
  el.append(p);
  return p;
});

let state = skyAt(null);
function render(t) {
  state = skyAt(override);
  if (slider) {
    if (override == null && document.activeElement !== slider) slider.value = state.hour;
    mark.style.left = `calc(6px + (100% - 12px) * ${cphNow().hour / 24})`;
    mark.hidden = back.hidden = override == null;
    slider.setAttribute("aria-valuetext", `${fmtHour(state.hour)}${override == null ? ", now" : ""}`);
  }
  if (drawView && visible.view) drawView(t);
  if (visible.plates) plates.forEach((p) => p.update(state, t));
}

// only animate what is on screen (browsers already pause hidden tabs)
const visible = { view: !fig, plates: !plates.length };
const platesBox = plateEls[0]?.closest("section");
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.target === fig) visible.view = e.isIntersecting;
    if (e.target === platesBox) visible.plates = e.isIntersecting;
  }
});
if (fig) io.observe(fig);
if (platesBox) io.observe(platesBox);

if (reduceMotion) {
  // a still picture: drawn once, and again when the theme, the size or the slider changes
  visible.view = visible.plates = true;
  render(performance.now() / 1000);
  new MutationObserver(() => render(performance.now() / 1000)).observe(root, { attributes: true, attributeFilter: ["class"] });
} else {
  let last = 0;
  const tick = (t) => { requestAnimationFrame(tick); if (t - last >= 1000 / 15 - 2) { last = t; render(t / 1000); } };
  requestAnimationFrame(tick);
}
// refit and redraw the view when the window changes size, and once the web font has settled the layout
const rebuild = () => { if (fig) { buildView(); if (reduceMotion) render(performance.now() / 1000); } };
let rt, lastSize = `${innerWidth}x${innerHeight}`;
addEventListener("resize", () => {
  clearTimeout(rt);
  rt = setTimeout(() => { const size = `${innerWidth}x${innerHeight}`; if (size !== lastSize) { lastSize = size; rebuild(); } }, 150);
});
document.fonts?.ready.then(rebuild);
})();
