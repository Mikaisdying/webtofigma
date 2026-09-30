// Web → Figma: dựng lại phiên ghi (.w2f.json) thành màn hình, component và prototype.
const VERSION = '0.6.1';
figma.showUI(__html__, { width: 360, height: 560, themeColors: true });
figma.ui.postMessage({ type: 'version', version: VERSION });

// ---------- Màu ----------
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function parseColor(str) {
  if (!str) return null;
  str = String(str).trim();
  if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = str.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].replace(/\s*\/\s*/, ',').split(/[\s,]+/).filter(Boolean);
    const ch = (v) => v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / 255;
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return { r: clamp01(ch(parts[0])), g: clamp01(ch(parts[1])), b: clamp01(ch(parts[2])), a: clamp01(a) };
  }
  m = str.match(/^color\(srgb\s+([^)]+)\)$/i);
  if (m) {
    const parts = m[1].replace(/\s*\/\s*/, ' ').split(/\s+/).filter(Boolean).map(parseFloat);
    return { r: clamp01(parts[0]), g: clamp01(parts[1]), b: clamp01(parts[2]), a: parts[3] === undefined ? 1 : clamp01(parts[3]) };
  }
  m = str.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  return null;
}

function solidPaint(str) {
  const c = parseColor(str);
  if (!c || c.a === 0) return null;
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}

// Tách chuỗi theo dấu phẩy ở cấp ngoài cùng (bỏ qua dấu phẩy trong ngoặc)
function splitTop(str, sep) {
  sep = sep || ',';
  const out = [];
  let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---------- Gradient ----------
function angleTransform(deg) {
  const rad = (deg - 90) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return [[c, s, 0.5 - 0.5 * c - 0.5 * s], [-s, c, 0.5 + 0.5 * s - 0.5 * c]];
}

const SIDE_ANGLES = {
  'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
  'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135,
  'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315,
};

function parseStops(parts) {
  const stops = [];
  parts.forEach((p, i) => {
    const m = p.match(/^((?:rgba?|color|hsla?)\([^)]*\)|#[0-9a-f]+|[a-z]+)\s*([-\d.]+%)?(?:\s+([-\d.]+%))?$/i);
    if (!m) return;
    const c = parseColor(m[1]);
    if (!c) return;
    let pos = m[2] !== undefined ? parseFloat(m[2]) / 100 : null;
    stops.push({ color: c, position: pos });
    if (m[3] !== undefined) stops.push({ color: c, position: parseFloat(m[3]) / 100 });
  });
  if (stops.length < 2) return null;
  // Điền vị trí còn thiếu
  if (stops[0].position === null) stops[0].position = 0;
  if (stops[stops.length - 1].position === null) stops[stops.length - 1].position = 1;
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].position !== null) continue;
    let j = i;
    while (stops[j].position === null) j++;
    const a = stops[i - 1].position, b = stops[j].position;
    for (let k = i; k < j; k++) stops[k].position = a + (b - a) * (k - i + 1) / (j - i + 1);
  }
  return stops.map((s) => ({ color: s.color, position: clamp01(s.position) }));
}

function gradientPaint(layer, w, h) {
  let m = layer.match(/^(repeating-)?linear-gradient\((.*)\)$/i);
  if (m) {
    const parts = splitTop(m[2]);
    let angle = 180;
    if (/^-?[\d.]+(deg|turn|rad|grad)$/.test(parts[0])) {
      const v = parseFloat(parts[0]);
      angle = parts[0].endsWith('turn') ? v * 360 : parts[0].endsWith('rad') ? v * 180 / Math.PI : parts[0].endsWith('grad') ? v * 0.9 : v;
      parts.shift();
    } else if (/^to /.test(parts[0])) {
      angle = SIDE_ANGLES[parts[0]] !== undefined ? SIDE_ANGLES[parts[0]] : 180;
      parts.shift();
    }
    const stops = parseStops(parts);
    if (!stops) return null;
    return { type: 'GRADIENT_LINEAR', gradientTransform: angleTransform(angle), gradientStops: stops };
  }
  m = layer.match(/^(repeating-)?radial-gradient\((.*)\)$/i);
  if (m) {
    const parts = splitTop(m[2]);
    let cx = 0.5, cy = 0.5, shape = '';
    if (!parseColor(parts[0].split(/\s+/)[0])) {
      shape = parts.shift();
      const at = shape.match(/at\s+([-\d.]+)%\s+([-\d.]+)%/);
      if (at) { cx = parseFloat(at[1]) / 100; cy = parseFloat(at[2]) / 100; }
    }
    // Bán kính theo tỉ lệ khung (CSS mặc định farthest-corner). Hình tròn: dùng bán kính lớn hơn cho cả hai trục.
    const dx = Math.max(cx, 1 - cx), dy = Math.max(cy, 1 - cy);
    let rx = dx * Math.SQRT2, ry = dy * Math.SQRT2;
    if (/closest-side/.test(shape)) { rx = Math.min(cx, 1 - cx); ry = Math.min(cy, 1 - cy); }
    else if (/farthest-side/.test(shape)) { rx = dx; ry = dy; }
    if (/circle/.test(shape) && w && h) {
      // Hình tròn: bán kính tính theo pixel rồi quy đổi về tỉ lệ từng chiều
      const px = /closest-side/.test(shape) ? Math.min(cx * w, (1 - cx) * w, cy * h, (1 - cy) * h)
        : /farthest-side/.test(shape) ? Math.max(dx * w, dy * h) : Math.hypot(dx * w, dy * h);
      rx = px / w; ry = px / h;
    } else if (/circle/.test(shape)) { const r = Math.max(rx, ry); rx = ry = r; }
    const stops = parseStops(parts);
    if (!stops || !rx || !ry) return null;
    // Figma: vòng tròn gradient có tâm (0.5, 0.5), bán kính 0.5 trong hệ toạ độ gradient
    const t = [[1 / (2 * rx), 0, 0.5 - cx / (2 * rx)], [0, 1 / (2 * ry), 0.5 - cy / (2 * ry)]];
    return { type: 'GRADIENT_RADIAL', gradientTransform: t, gradientStops: stops };
  }
  m = layer.match(/^(repeating-)?conic-gradient\((.*)\)$/i);
  if (m) {
    const parts = splitTop(m[2]);
    let from = 0;
    if (/^(from|at)\b/.test(parts[0])) {
      const f = parts.shift().match(/from\s+(-?[\d.]+)deg/);
      if (f) from = parseFloat(f[1]);
    }
    // Vị trí màu kiểu góc (90deg) đổi sang phần trăm vòng tròn
    const stops = parseStops(parts.map((p) => p.replace(/(-?[\d.]+)deg/g, (x, v) => `${parseFloat(v) / 3.6}%`)));
    if (!stops) return null;
    // CSS bắt đầu từ hướng 12 giờ, quay theo chiều kim đồng hồ
    return { type: 'GRADIENT_ANGULAR', gradientTransform: angleTransform(from), gradientStops: stops };
  }
  return null;
}

// ---------- Bóng đổ & hiệu ứng ----------
function parseShadows(str) {
  if (!str) return [];
  const effects = [];
  for (const s of splitTop(str)) {
    const colorMatch = s.match(/(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]+)/i);
    const c = colorMatch ? parseColor(colorMatch[1]) : { r: 0, g: 0, b: 0, a: 1 };
    if (!c || c.a === 0) continue;
    const rest = s.replace(colorMatch ? colorMatch[1] : '', '');
    const inset = /\binset\b/.test(rest);
    const nums = (rest.match(/-?[\d.]+px|\b0\b/g) || []).map(parseFloat);
    effects.push({
      type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: c,
      offset: { x: nums[0] || 0, y: nums[1] || 0 },
      radius: nums[2] || 0,
      spread: nums[3] || 0,
      visible: true,
      blendMode: 'NORMAL',
    });
  }
  return effects.reverse();
}

function blurEffect(str, type) {
  if (!str) return null;
  const m = str.match(/blur\(([\d.]+)px\)/);
  if (!m) return null;
  return { type, radius: parseFloat(m[1]), visible: true };
}

// ---------- Font ----------
let fontIndex = null; // family(lowercase) -> { family, styles: [] }
const loadedFonts = new Set();
const missingFonts = new Set();

async function buildFontIndex() {
  const fonts = await figma.listAvailableFontsAsync();
  fontIndex = {};
  for (const f of fonts) {
    const key = f.fontName.family.toLowerCase();
    if (!fontIndex[key]) fontIndex[key] = { family: f.fontName.family, styles: [] };
    fontIndex[key].styles.push(f.fontName.style);
  }
}

const WEIGHT_NAMES = [
  [100, /thin|hairline/i], [200, /extra ?light|ultra ?light/i], [300, /light/i],
  [500, /medium/i], [600, /semi ?bold|demi ?bold/i], [800, /extra ?bold|ultra ?bold/i],
  [900, /black|heavy/i], [700, /bold/i],
];
function styleWeight(style) {
  for (const [w, re] of WEIGHT_NAMES) if (re.test(style)) return w;
  return 400;
}

const GENERIC = {
  'serif': ['Georgia', 'Times New Roman', 'Noto Serif', 'Lora'],
  'sans-serif': ['Inter', 'Arial', 'Helvetica'],
  'system-ui': ['Inter', 'SF Pro Text', 'Segoe UI', 'Roboto'],
  '-apple-system': ['SF Pro Text', 'Inter'],
  'blinkmacsystemfont': ['SF Pro Text', 'Inter'],
  'monospace': ['Roboto Mono', 'Courier New', 'Menlo'],
  'cursive': ['Caveat', 'Comic Sans MS'],
  'ui-serif': ['Georgia', 'Noto Serif'],
  'ui-sans-serif': ['Inter'],
  'ui-monospace': ['Roboto Mono', 'Menlo'],
};

function pickFont(familyList, weight, italic) {
  const names = splitTop(familyList || '').map((f) => f.replace(/^["']|["']$/g, '').trim());
  let entry = null;
  for (const n of names) {
    const low = n.toLowerCase();
    if (fontIndex[low]) { entry = fontIndex[low]; break; }
    if (GENERIC[low]) {
      for (const g of GENERIC[low]) if (fontIndex[g.toLowerCase()]) { entry = fontIndex[g.toLowerCase()]; break; }
      if (entry) break;
    }
  }
  if (!entry) {
    if (names[0]) missingFonts.add(names[0]);
    entry = fontIndex['inter'] || fontIndex[Object.keys(fontIndex)[0]];
  }
  let best = null, bestScore = Infinity;
  for (const st of entry.styles) {
    const isItalic = /italic|oblique/i.test(st);
    const score = Math.abs(styleWeight(st) - weight) + (isItalic !== !!italic ? 1000 : 0) + (/condensed|expanded|narrow|wide|display|caption/i.test(st) ? 50 : 0);
    if (score < bestScore) { bestScore = score; best = st; }
  }
  return { family: entry.family, style: best };
}

async function ensureFont(fontName) {
  const key = fontName.family + '|' + fontName.style;
  if (loadedFonts.has(key)) return;
  await figma.loadFontAsync(fontName);
  loadedFonts.add(key);
}

// ---------- Tiện ích ----------
function hasVisual(st) {
  if (!st) return false;
  const bg = parseColor(st.bg);
  if (bg && bg.a > 0) return true;
  if (st.bgImage) return true;
  if (st.border && st.border.some((b) => b.w > 0 && b.s !== 'none' && b.s !== 'hidden' && (parseColor(b.c) || { a: 0 }).a > 0)) return true;
  if (st.shadow) return true;
  if (st.blur) return true;
  return false;
}

// Ảnh nền đơn (SVG hoặc ảnh thường): dựng thành lớp "background" nằm dưới nội dung, cắt theo khung phần tử
function addBackgroundLayer(frame, st, w, h) {
  const L = st && st.bgLayer;
  if (!L || (L.kind === 'image' && L.repeat)) return;
  try {
    const clip = figma.createFrame();
    clip.name = 'background';
    clip.resize(Math.max(0.01, w), Math.max(0.01, h));
    clip.fills = [];
    clip.clipsContent = true;
    if (st.radius) {
      const maxR = Math.min(w, h) / 2;
      const r = st.radius.map((v) => Math.min(v || 0, maxR));
      clip.topLeftRadius = r[0]; clip.topRightRadius = r[1]; clip.bottomRightRadius = r[2]; clip.bottomLeftRadius = r[3];
    }
    let art;
    if (L.kind === 'svg') {
      art = figma.createNodeFromSvg(L.svg);
      art.resize(Math.max(0.01, L.w), Math.max(0.01, L.h));
    } else {
      art = figma.createRectangle();
      art.resize(Math.max(0.01, L.w), Math.max(0.01, L.h));
      const img = figma.createImage(figma.base64Decode(L.data.split(',')[1]));
      art.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
    }
    art.name = 'background image';
    clip.appendChild(art);
    art.x = L.x; art.y = L.y;
    frame.insertChild(0, clip);
    clip.x = 0; clip.y = 0;
  } catch (e) { stats.failed++; }
}

// Bóng đổ theo hình (filter: drop-shadow): thêm vào các hiệu ứng sẵn có
function applyDropShadows(node, st) {
  const list = st && st.dropShadows;
  if (!list || !('effects' in node)) return;
  const add = [];
  for (const d of list) {
    const c = parseColor(d.color);
    if (!c || c.a === 0) continue;
    add.push({ type: 'DROP_SHADOW', color: c, offset: { x: d.x, y: d.y }, radius: d.blur, spread: 0, visible: true, blendMode: 'NORMAL', showShadowBehindNode: false });
  }
  if (add.length) node.effects = add.reverse().concat(node.effects || []);
}

function noteUnsupported(n) {
  const st = n.style;
  if (st && st.filterOther) for (const f of st.filterOther) {
    const name = f.split('(')[0];
    stats.unsupported[name] = (stats.unsupported[name] || 0) + 1;
  }
}

function applyBoxStyle(node, st, w, h) {
  if (!st) return;
  const fills = [];
  const bg = solidPaint(st.bg);
  if (bg) fills.push(bg);
  if (st.bgImage) {
    const layers = splitTop(st.bgImage).reverse(); // lớp CSS đầu tiên nằm trên cùng
    for (const layer of layers) {
      if (/^url\(/.test(layer)) {
        const L = st.bgLayer;
        if (L && L.kind === 'image' && L.repeat && L.data) {
          try {
            const img = figma.createImage(figma.base64Decode(L.data.split(',')[1]));
            fills.push({ type: 'IMAGE', imageHash: img.hash, scaleMode: 'TILE', scalingFactor: L.natW ? L.w / L.natW : 1 });
          } catch (e) { stats.failed++; }
        } else if (!L && st.bgImageData) {
          try {
            const img = figma.createImage(figma.base64Decode(st.bgImageData.split(',')[1]));
            fills.push({ type: 'IMAGE', imageHash: img.hash, scaleMode: /contain/.test(st.bgSize) ? 'FIT' : 'FILL' });
          } catch (e) { /* bỏ qua ảnh lỗi */ }
        }
      } else {
        const g = gradientPaint(layer, w, h);
        if (g) fills.push(g);
      }
    }
  }
  node.fills = fills;

  // Viền
  const sides = st.border || [];
  const active = sides.filter((b) => b.w > 0 && b.s !== 'none' && b.s !== 'hidden' && (parseColor(b.c) || { a: 0 }).a > 0);
  if (active.length) {
    const p = solidPaint(active[0].c);
    if (p) {
      node.strokes = [p];
      node.strokeAlign = 'INSIDE';
      const ws = sides.map((b) => (b.s === 'none' || b.s === 'hidden' ? 0 : b.w));
      if (ws.every((v) => v === ws[0])) node.strokeWeight = ws[0];
      else {
        node.strokeTopWeight = ws[0]; node.strokeRightWeight = ws[1];
        node.strokeBottomWeight = ws[2]; node.strokeLeftWeight = ws[3];
      }
      if (active[0].s === 'dashed') node.dashPattern = [active[0].w * 3, active[0].w * 2];
      if (active[0].s === 'dotted') node.dashPattern = [active[0].w, active[0].w];
    }
  }

  // Bo góc
  if (st.radius && 'topLeftRadius' in node) {
    const maxR = Math.min(w, h) / 2;
    const r = st.radius.map((v) => Math.min(v || 0, maxR));
    node.topLeftRadius = r[0]; node.topRightRadius = r[1];
    node.bottomRightRadius = r[2]; node.bottomLeftRadius = r[3];
  }

  const effects = parseShadows(st.shadow);
  const bb = blurEffect(st.blur, 'BACKGROUND_BLUR');
  if (bb) effects.push(bb);
  const lb = blurEffect(st.filter, 'LAYER_BLUR');
  if (lb) effects.push(lb);
  if (effects.length) node.effects = effects;
  if (st.opacity < 1) node.opacity = st.opacity;
}

// ---------- Dựng node ----------
let stats;
let progressTick = 0;
// Ngữ cảnh của bước đang dựng
let ctx = { refMap: {}, clickBoxes: [], registry: [] };
const compSets = {}; // key -> { set, variants: { Default, Hover, Pressed } }

function resetStats() { stats = { unsupported: {}, merged: 0, steps: 0, overlays: 0, shared: 0, rotated: 0, frames: 0, texts: 0, images: 0, svgs: 0, components: 0, instances: 0, links: 0, failed: 0 }; }

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const uni = a.w * a.h + b.w * b.h - inter;
  return uni > 0 ? inter / uni : 0;
}
const isClickTarget = (box) => ctx.clickBoxes.some((c) => iou(c, box) > 0.85);

function place(node, parent, box, ox, oy) {
  parent.appendChild(node);
  node.x = box.x - ox;
  node.y = box.y - oy;
  ctx.registry.push({ node, box });
}

async function buildText(n, parent, ox, oy) {
  const f = n.font;
  const fontName = pickFont(f.family, f.weight, f.italic);
  await ensureFont(fontName);
  const t = figma.createText();
  t.fontName = fontName;
  t.characters = n.text;
  t.fontSize = Math.max(1, f.size || 16);
  const paint = solidPaint(f.color);
  t.fills = paint ? [paint] : [];
  if (f.lineHeight) t.lineHeight = { unit: 'PIXELS', value: f.lineHeight };
  if (f.letterSpacing) t.letterSpacing = { unit: 'PIXELS', value: f.letterSpacing };
  const alignMap = { left: 'LEFT', start: 'LEFT', center: 'CENTER', right: 'RIGHT', end: 'RIGHT', justify: 'JUSTIFIED', '-webkit-center': 'CENTER' };
  t.textAlignHorizontal = alignMap[f.align] || 'LEFT';
  const caseMap = { uppercase: 'UPPER', lowercase: 'LOWER', capitalize: 'TITLE' };
  if (caseMap[f.transform]) t.textCase = caseMap[f.transform];
  if (/underline/.test(f.decoration || '')) t.textDecoration = 'UNDERLINE';
  else if (/line-through/.test(f.decoration || '')) t.textDecoration = 'STRIKETHROUGH';
  t.name = n.name || n.text.slice(0, 40);
  parent.appendChild(t);
  const b = n.box;
  if ((n.lines || 1) > 1) {
    t.textAutoResize = 'HEIGHT';
    t.resize(Math.max(1, b.w + 1), Math.max(1, b.h));
    t.x = b.x - ox;
  } else {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
    let x = b.x;
    if (t.textAlignHorizontal === 'CENTER') x = b.x + (b.w - t.width) / 2;
    else if (t.textAlignHorizontal === 'RIGHT') x = b.x + b.w - t.width;
    t.x = x - ox;
  }
  t.y = (n.vcenter ? b.y + (b.h - t.height) / 2 : b.y) - oy;
  ctx.registry.push({ node: t, box: b });
  stats.texts++;
  return t;
}

function buildImage(n, parent, ox, oy) {
  const b = n.box;
  const r = figma.createRectangle();
  r.name = n.name || 'image';
  r.resize(Math.max(0.01, b.w), Math.max(0.01, b.h));
  place(r, parent, b, ox, oy);
  // Nền, viền, bo góc của khung ảnh
  applyBoxStyle(r, Object.assign({}, n.style, { bgImage: null }), b.w, b.h);
  const under = r.fills.slice();
  if (n.src) {
    try {
      const img = figma.createImage(figma.base64Decode(n.src.split(',')[1]));
      const modeMap = { contain: 'FIT', 'scale-down': 'FIT', cover: 'FILL', fill: 'FILL', none: 'CROP' };
      r.fills = under.concat([{ type: 'IMAGE', imageHash: img.hash, scaleMode: modeMap[n.fit] || 'FILL' }]);
      stats.images++;
      return r;
    } catch (e) { /* rơi xuống placeholder */ }
  }
  r.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
  r.name += ' (không tải được ảnh)';
  stats.failed++;
  return r;
}

function buildSvg(n, parent, ox, oy) {
  const b = n.box;
  try {
    const node = figma.createNodeFromSvg(n.svg);
    node.name = n.name || 'svg';
    if (b.w > 0 && b.h > 0) node.resize(b.w, b.h);
    place(node, parent, b, ox, oy);
    stats.svgs++;
    return node;
  } catch (e) { stats.failed++; }
}

function buildControl(n, frame) {
  const w = n.box.w, h = n.box.h;
  if (n.range) {
    const accent = solidPaint(n.range.accent) || { type: 'SOLID', color: { r: 0.2, g: 0.45, b: 0.9 } };
    const pct = (n.range.value - n.range.min) / ((n.range.max - n.range.min) || 1);
    const track = figma.createRectangle();
    track.name = 'track'; track.resize(Math.max(1, w), 4); track.cornerRadius = 2;
    track.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
    frame.appendChild(track); track.x = 0; track.y = h / 2 - 2;
    const fill = figma.createRectangle();
    fill.name = 'progress'; fill.resize(Math.max(0.01, w * pct), 4); fill.cornerRadius = 2; fill.fills = [accent];
    frame.appendChild(fill); fill.x = 0; fill.y = h / 2 - 2;
    const d = Math.min(16, h);
    const thumb = figma.createEllipse();
    thumb.name = 'thumb'; thumb.resize(d, d); thumb.fills = [accent];
    frame.appendChild(thumb); thumb.x = Math.max(0, w * pct - d / 2); thumb.y = h / 2 - d / 2;
  } else if (typeof n.checked === 'boolean' && !hasVisual(n.style)) {
    frame.strokes = [{ type: 'SOLID', color: { r: 0.45, g: 0.45, b: 0.45 } }];
    frame.strokeWeight = 1.5;
    frame.cornerRadius = /radio/.test(n.name) ? w / 2 : 3;
    if (n.checked) frame.fills = [{ type: 'SOLID', color: { r: 0.2, g: 0.45, b: 0.9 } }];
  }
}

async function buildBox(n, parent, ox, oy) {
  const b = n.box;
  const visual = hasVisual(n.style);
  const control = !!n.range || typeof n.checked === 'boolean';
  const kids = n.children || [];
  if (!visual && !control && !kids.length) return;
  // Khung trống chỉ có 1 con: bỏ qua cho gọn, trừ khi đó là nút được bấm trong kịch bản
  if (!visual && !control && !n.xf && !n.style.clip && kids.length === 1 && (!n.style.opacity || n.style.opacity >= 1) && !isClickTarget(b)) {
    return await buildAny(kids[0], parent, ox, oy);
  }
  const frame = figma.createFrame();
  frame.name = n.name || 'div';
  frame.resize(Math.max(0.01, b.w), Math.max(0.01, b.h));
  frame.clipsContent = !!n.style.clip;
  frame.fills = [];
  place(frame, parent, b, ox, oy);
  applyBoxStyle(frame, n.style, b.w, b.h);
  addBackgroundLayer(frame, n.style, b.w, b.h);
  if (control) buildControl(n, frame);
  stats.frames++;
  for (const c of kids) await buildAny(c, frame, b.x, b.y);
  return frame;
}

// Ghi lại vị trí trên trang của các lớp bên trong instance, để tìm được nút cần nối prototype
function registerInstance(inst, box) {
  const walk = (node, px, py) => {
    for (const c of node.children || []) {
      const b = { x: px + c.x, y: py + c.y, w: c.width, h: c.height };
      ctx.registry.push({ node: c, box: b });
      walk(c, b.x, b.y);
    }
  };
  walk(inst, box.x, box.y);
}

function buildInstance(n, main, name, parent, ox, oy) {
  const inst = main.createInstance();
  inst.name = name;
  place(inst, parent, n.box, ox, oy);
  registerInstance(inst, n.box);
  stats.instances++;
  return inst;
}

async function buildAny(n, parent, ox, oy) {
  if (++progressTick % 40 === 0) {
    figma.ui.postMessage({ type: 'progress', stats });
    await new Promise((r) => setTimeout(r, 0));
  }
  try {
    let node;
    const key = n.ref && ctx.refMap[n.ref];
    if (key && compSets[key]) node = buildInstance(n, compSets[key].variants.Default, compSets[key].name, parent, ox, oy);
    else if (n.type === 'box' && shared.enabled && shared.eligible.has(n._h)) {
      const main = await sharedMain(n);
      node = buildInstance(n, main, main.name, parent, ox, oy);
    }
    else if (n.type === 'text') node = await buildText(n, parent, ox, oy);
    else if (n.type === 'image') node = buildImage(n, parent, ox, oy);
    else if (n.type === 'svg') node = buildSvg(n, parent, ox, oy);
    else node = await buildBox(n, parent, ox, oy);
    if (node && n.type !== 'text' && !(key && compSets[key])) applyDropShadows(node, n.style);
    noteUnsupported(n);
    if (node && n.xf) applyTransform(node, n);
    return node;
  } catch (e) {
    stats.failed++;
  }
}

// Áp transform CSS (xoay, co giãn quanh transform-origin) lên node đang ở vị trí chưa xoay
function applyTransform(node, n) {
  const x = n.xf;
  const sx = Math.hypot(x.a, x.b);
  if (!sx) return;
  const sy = (x.a * x.d - x.b * x.c) / sx;
  if (Math.abs(x.a * x.c + x.b * x.d) / (sx * Math.abs(sy) || 1) > 0.02) stats.unsupported['skew'] = (stats.unsupported['skew'] || 0) + 1;
  const angle = Math.atan2(x.b, x.a);
  const scale = (Math.abs(sx) + Math.abs(sy)) / 2;
  if (Math.abs(scale - 1) > 0.01 && typeof node.rescale === 'function') {
    try { node.rescale(scale); } catch (e) { /* node không co giãn được */ }
  }
  // Điểm p trong node → M·p + (origin - M·origin + dịch chuyển)
  const tx = x.ox - (x.a * x.ox + x.c * x.oy) + x.e;
  const ty = x.oy - (x.b * x.ox + x.d * x.oy) + x.f;
  const X = node.x, Y = node.y;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  node.relativeTransform = [[cos, -sin, X + tx], [sin, cos, Y + ty]];
  stats.rotated++;
}

// ---------- Tìm phần lặp lại giữa các màn ----------
function cyrb53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Băm cây con theo nội dung và vị trí tương đối (không phụ thuộc vị trí trên trang)
function hashTree(n) {
  const R = Math.round;
  let size = 1;
  const kids = (n.children || []).map((c) => {
    const h = hashTree(c);
    size += c._size;
    return [R(c.box.x - n.box.x), R(c.box.y - n.box.y), h];
  });
  const src = n.src ? n.src.length + n.src.slice(0, 80) + n.src.slice(-80) : null;
  const sig = JSON.stringify([n.type, R(n.box.w), R(n.box.h), n.style || null, n.font || null, n.text || null, src, n.svg || null, n.checked, n.range, n.xf || null, kids],
    (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v));
  n._h = cyrb53(sig);
  n._size = size;
  return n._h;
}

const shared = { enabled: false, eligible: new Set(), mains: {}, names: {}, section: null };

function findShared(steps) {
  const seen = {}; // hash -> Set(stepId)
  for (const s of steps) {
    if (!s.root) continue;
    hashTree(s.root);
    const refs = s.refMap || {};
    const visit = (n, isRoot) => {
      if (!isRoot && n.type === 'box' && n._size >= 3 && n.box.w * n.box.h >= 400 && !(n.ref && refs[n.ref])) {
        (seen[n._h] = seen[n._h] || new Set()).add(s.id);
        if (!shared.names[n._h]) shared.names[n._h] = n.name;
      }
      for (const c of n.children || []) visit(c, false);
    };
    visit(s.root, true);
  }
  const candidates = new Set(Object.keys(seen).filter((h) => seen[h].size >= 2));
  // Chỉ giữ phần lặp lại có lúc đứng độc lập, bỏ phần lúc nào cũng nằm trong một phần lặp lại khác
  const standalone = new Set();
  for (const s of steps) {
    if (!s.root) continue;
    const visit = (n, inside) => {
      const is = candidates.has(n._h);
      if (is && !inside) standalone.add(n._h);
      for (const c of n.children || []) visit(c, inside || is);
    };
    visit(s.root, false);
  }
  for (const h of standalone) shared.eligible.add(h);
}

async function sharedMain(n) {
  if (shared.mains[n._h]) return shared.mains[n._h];
  const saved = ctx.registry;
  ctx.registry = []; // lớp bên trong component không thuộc màn đang dựng
  const comp = figma.createComponent();
  comp.name = `Shared / ${n.name || 'section'}`;
  const b = n.box;
  comp.resize(Math.max(0.01, b.w), Math.max(0.01, b.h));
  comp.fills = [];
  comp.clipsContent = !!(n.style && n.style.clip);
  shared.section.appendChild(comp);
  shared.mains[n._h] = comp;
  applyBoxStyle(comp, n.style, b.w, b.h);
  addBackgroundLayer(comp, n.style, b.w, b.h);
  for (const c of n.children || []) await buildAny(c, comp, b.x, b.y);
  ctx.registry = saved;
  stats.shared++;
  return comp;
}

// ---------- Component Default / Hover / Pressed ----------
async function buildVariant(tree, state) {
  const comp = figma.createComponent();
  comp.name = `State=${state}`;
  const b = tree.box;
  comp.resize(Math.max(0.01, b.w), Math.max(0.01, b.h));
  comp.fills = [];
  comp.clipsContent = false;
  if (tree.type === 'box') {
    applyBoxStyle(comp, tree.style, b.w, b.h);
    addBackgroundLayer(comp, tree.style, b.w, b.h);
    applyDropShadows(comp, tree.style);
    if (tree.range || typeof tree.checked === 'boolean') buildControl(tree, comp);
    for (const c of tree.children || []) await buildAny(c, comp, b.x, b.y);
  } else {
    await buildAny(tree, comp, b.x, b.y);
  }
  return comp;
}

const HOVER_TRANSITION = { type: 'SMART_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.15 };

function sameLook(a, b, tol, pa, pb) {
  if (!a || !b) return a === b;
  if (a.type !== b.type || (a.text || '') !== (b.text || '')) return false;
  const ax = a.box.x - (pa ? pa.box.x : a.box.x), ay = a.box.y - (pa ? pa.box.y : a.box.y);
  const bx = b.box.x - (pb ? pb.box.x : b.box.x), by = b.box.y - (pb ? pb.box.y : b.box.y);
  if (Math.abs(ax - bx) > tol || Math.abs(ay - by) > tol || Math.abs(a.box.w - b.box.w) > tol || Math.abs(a.box.h - b.box.h) > tol) return false;
  const clean = (n) => JSON.stringify([n.style && Object.assign({}, n.style, { bgLayer: null, bgImageData: null }), n.font && Object.assign({}, n.font, { size: Math.round(n.font.size) }), n.svg ? n.svg.length : 0],
    (k, v) => (typeof v === 'number' ? Math.round(v / 2) * 2 : v));
  if (clean(a) !== clean(b)) return false;
  const ka = a.children || [], kb = b.children || [];
  return ka.length === kb.length && ka.every((c, i) => sameLook(c, kb[i], tol, a, b));
}

async function buildComponents(list, section) {
  // Gộp component giống nhau: cùng tên thì cho lệch tới 12px (file cũ chụp giữa hiệu ứng), khác tên thì 4px
  const canon = [];
  const alias = {};
  for (const c of list) {
    const hit = canon.find((k) => !!k.hover === !!c.hover && !!k.active === !!c.active && sameLook(k.base, c.base, k.name === c.name ? 12 : 4));
    if (hit) { alias[c.key] = hit.key; stats.merged++; } else canon.push(c);
  }
  list = canon;
  const saved = ctx;
  const savedShared = shared.enabled;
  ctx = { refMap: {}, clickBoxes: [], registry: [] }; // không lồng instance trong component nút
  shared.enabled = false;
  for (const c of list) {
    try {
      const variants = { Default: await buildVariant(c.base, 'Default') };
      if (c.hover) variants.Hover = await buildVariant(c.hover, 'Hover');
      if (c.active) variants.Pressed = await buildVariant(c.active, 'Pressed');
      const set = figma.combineAsVariants(Object.values(variants), section);
      set.name = c.name || 'Button';
      let vx = 20;
      for (const v of Object.values(variants)) { v.x = vx; v.y = 20; vx += v.width + 20; }
      const h = Math.max(...Object.values(variants).map((v) => v.height));
      set.resizeWithoutConstraints(vx, h + 40);
      set.strokes = [{ type: 'SOLID', color: { r: 0.59, g: 0.28, b: 1 } }];
      set.dashPattern = [6, 4];
      set.cornerRadius = 6;
      const reactions = [];
      if (variants.Hover) reactions.push({ trigger: { type: 'ON_HOVER' }, actions: [{ type: 'NODE', destinationId: variants.Hover.id, navigation: 'CHANGE_TO', transition: HOVER_TRANSITION }] });
      if (variants.Pressed) reactions.push({ trigger: { type: 'ON_PRESS' }, actions: [{ type: 'NODE', destinationId: variants.Pressed.id, navigation: 'CHANGE_TO', transition: HOVER_TRANSITION }] });
      if (reactions.length) await variants.Default.setReactionsAsync(reactions);
      compSets[c.key] = { set, variants, name: c.name, hoverReactions: reactions };
      stats.components++;
    } catch (e) {
      stats.failed++;
    }
  }
  for (const [k, v] of Object.entries(alias)) if (compSets[v]) compSets[k] = compSets[v];
  ctx = saved;
  shared.enabled = savedShared;
}

// Xếp các component trong section thành hàng
function layoutSection(section) {
  const pad = 40, gap = 40, maxRowW = 1600;
  let x = pad, y = pad + 20, rowH = 0, maxX = 0;
  for (const c of section.children) {
    if (x > pad && x + c.width > pad + maxRowW) { x = pad; y += rowH + gap; rowH = 0; }
    c.x = x; c.y = y;
    x += c.width + gap; rowH = Math.max(rowH, c.height); maxX = Math.max(maxX, x);
  }
  section.resizeWithoutConstraints(Math.max(400, maxX - gap + pad), y + rowH + pad);
}

// ---------- Màn hình ----------
function newFrame(name, w, h, fills) {
  const frame = figma.createFrame();
  frame.name = name;
  frame.resize(Math.max(1, w), Math.max(1, h));
  frame.clipsContent = true;
  frame.fills = fills;
  figma.currentPage.appendChild(frame);
  return frame;
}

async function buildStep(step, clickBoxes, useComponents) {
  ctx = { refMap: useComponents ? (step.refMap || {}) : {}, clickBoxes, registry: [] };
  const p = step.page;
  const fills = [solidPaint(p.bg) || { type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  if (p.bgImage) for (const layer of splitTop(p.bgImage).reverse()) { const g = gradientPaint(layer); if (g) fills.push(g); }
  const frame = newFrame(`${String(step.index).padStart(2, '0')} · ${step.name}`, p.w, p.h, fills);
  const root = step.root;
  if (root) {
    const bodyStyle = Object.assign({}, root.style);
    if (bodyStyle.bg === p.bg) bodyStyle.bg = null;
    if (hasVisual(bodyStyle)) {
      const bodyBg = figma.createFrame();
      bodyBg.name = 'body';
      bodyBg.resize(Math.max(0.01, root.box.w), Math.max(0.01, root.box.h));
      bodyBg.fills = [];
      bodyBg.clipsContent = false;
      place(bodyBg, frame, root.box, 0, 0);
      applyBoxStyle(bodyBg, bodyStyle, root.box.w, root.box.h);
      for (const c of root.children || []) await buildAny(c, bodyBg, root.box.x, root.box.y);
    } else {
      for (const c of root.children || []) await buildAny(c, frame, 0, 0);
    }
  }
  stats.steps++;
  return { frame, registry: ctx.registry };
}

// Modal: chỉ dựng các lớp của modal trong một frame bằng khung nhìn, mở đè lên màn bên dưới
async function buildOverlay(step, clickBoxes, useComponents) {
  ctx = { refMap: useComponents ? (step.refMap || {}) : {}, clickBoxes, registry: [] };
  const m = step.modal;
  const bd = m.backdrop ? solidPaint(m.backdrop) : null;
  const frame = newFrame(`${String(step.index).padStart(2, '0')} · ${step.name} (${m.kind === 'menu' ? 'menu' : 'overlay'})`, m.viewport.w, m.viewport.h, bd ? [bd] : []);
  for (const layer of m.layers) await buildAny(layer, frame, m.scroll.x, m.scroll.y);
  stats.steps++;
  stats.overlays++;
  return { frame, registry: ctx.registry, overlay: true };
}

// Tìm layer ứng với nút đã bấm: ưu tiên instance, sau đó frame, rồi tới chữ
function findTarget(registry, box, text) {
  let best = null, bestScore = 0;
  for (const r of registry) {
    let s = iou(r.box, box);
    if (s < 0.5) continue;
    if (r.node.type === 'INSTANCE') s += 0.3;
    else if (r.node.type === 'FRAME') s += 0.1;
    if (s > bestScore) { bestScore = s; best = r.node; }
  }
  if (!best && text) {
    best = (registry.find((r) => r.node.type === 'TEXT' && r.node.characters === text) || {}).node || null;
  }
  return best;
}

function nextFreeX() {
  let maxX = 0;
  for (const c of figma.currentPage.children) maxX = Math.max(maxX, c.x + c.width);
  return figma.currentPage.children.length ? maxX + 200 : 0;
}

// Đổi file cũ của capture.js (1 trang) sang dạng nhiều bước
function normalize(data, fileName) {
  if (data.format === 'web2figma-recording') return data;
  if (data.page && data.root) {
    return { title: data.title || fileName, viewport: data.viewport, components: [], steps: [{ id: 's1', index: 1, name: data.title || fileName, page: data.page, root: data.root, refMap: {}, trigger: { type: 'start' } }] };
  }
  throw new Error('File không đúng định dạng của Web → Figma');
}

const DISSOLVE = { type: 'DISSOLVE', easing: { type: 'EASE_OUT' }, duration: 0.2 };

// Vùng bấm trong suốt (vẫn nhận click trong chế độ Present)
function hotspot(frame, name, x, y, w, h, index) {
  const r = figma.createRectangle();
  r.name = name;
  r.resize(Math.max(1, w), Math.max(1, h));
  r.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.001 }];
  if (index === undefined) frame.appendChild(r); else frame.insertChild(index, r);
  r.x = x; r.y = y;
  return r;
}

async function buildRecording(data, opts) {
  const steps = data.steps.filter((s) => opts.steps.includes(s.id));
  const selected = new Set(steps.map((s) => s.id));
  const useComponents = !!(opts.components && data.components && data.components.length);
  const startX = nextFreeX();

  // Danh sách chuyển màn. File cũ không có transitions thì suy ra từ trigger của từng bước.
  const transitions = (data.transitions || data.steps
    .filter((s) => s.trigger && s.trigger.type === 'click' && s.trigger.fromStep)
    .map((s) => ({ from: s.trigger.fromStep, to: s.id, trigger: s.trigger })))
    .filter((t) => t.trigger && t.trigger.type === 'click' && t.trigger.box && selected.has(t.from) && selected.has(t.to));

  // Màn chụp tay là biến thể của màn trước đó (ví dụ đã gõ chữ): nút ở màn trước cũng dẫn tới cùng chỗ
  for (const s of steps) {
    const t = s.trigger || {};
    if (t.type !== 'manual' || !t.fromStep || !selected.has(t.fromStep)) continue;
    for (const tr of transitions.slice()) {
      if (tr.from !== s.id) continue;
      if (!transitions.some((x) => x.from === t.fromStep && x.trigger.text === tr.trigger.text)) {
        transitions.push({ from: t.fromStep, to: tr.to, trigger: tr.trigger });
      }
    }
  }

  // Bước nào là modal (dựng thành overlay) và mở từ màn nào
  const overlays = new Set();
  const baseOf = {};
  if (opts.overlay) {
    for (const s of steps) {
      if (!s.modal || !s.modal.layers || !s.modal.layers.length) continue;
      const opener = transitions.find((t) => t.to === s.id && (t.trigger.change === 'modal-open' || t.trigger.change === 'menu-open'));
      if (!opener) continue;
      overlays.add(s.id);
      baseOf[s.id] = opener.from;
    }
  }

  // Section chứa mọi component
  const section = figma.createSection();
  section.name = `Components · ${data.title || ''}`;
  figma.currentPage.appendChild(section);
  shared.section = section;
  shared.enabled = !!opts.shared;
  if (useComponents) {
    figma.ui.postMessage({ type: 'status', text: 'Đang tạo component nút...' });
    await buildComponents(data.components, section);
  }
  if (shared.enabled) findShared(steps.filter((s) => !overlays.has(s.id)));

  const clicksFrom = {};
  for (const t of transitions) (clicksFrom[t.from] = clicksFrom[t.from] || []).push(t.trigger.box);

  const built = {};
  for (const s of steps) {
    figma.ui.postMessage({ type: 'status', text: `Đang dựng bước ${s.index}: ${s.name}` });
    built[s.id] = overlays.has(s.id)
      ? await buildOverlay(s, clicksFrom[s.id] || [], useComponents)
      : await buildStep(s, clicksFrom[s.id] || [], useComponents);
  }

  // Bố cục: section component ở trên, các màn xếp thành hàng bên dưới
  const nodes = [];
  if (section.children.length) {
    layoutSection(section);
    section.x = startX; section.y = 0;
    nodes.push(section);
  } else section.remove();
  let x = startX;
  const top = section.removed ? 0 : section.height + 200;
  for (const s of steps) {
    const f = built[s.id].frame;
    f.x = x; f.y = top;
    x += f.width + 120;
    nodes.push(f);
  }

  // Prototype
  const missing = [];
  if (opts.prototype) {
    const indexOf = {};
    for (const s of steps) indexOf[s.id] = s.index;
    const done = new Set();
    for (const tr of transitions) {
      const t = tr.trigger;
      let target = findTarget(built[tr.from].registry, t.box, t.text);
      // Nút nằm ở màn bên dưới overlay (ví dụ bấm lại nút đã mở menu): tạo vùng bấm trong suốt đúng vị trí đó
      if (!target && overlays.has(tr.from)) {
        const m = steps.find((x) => x.id === tr.from).modal;
        target = hotspot(built[tr.from].frame, `Vùng bấm: ${t.text}`, t.box.x - m.scroll.x, t.box.y - m.scroll.y, t.box.w, t.box.h);
      }
      if (!target) { missing.push(`${t.text} (bước ${indexOf[tr.from]})`); continue; }
      if (done.has(target.id)) continue; // mỗi nút một đích
      let action;
      const fromOverlay = overlays.has(tr.from), toOverlay = overlays.has(tr.to);
      if (fromOverlay && tr.to === baseOf[tr.from] && (t.change === 'modal-close' || t.change === 'menu-close')) action = { type: 'CLOSE' };
      else if (toOverlay) action = { type: 'NODE', destinationId: built[tr.to].frame.id, navigation: fromOverlay ? 'SWAP' : 'OVERLAY', transition: DISSOLVE };
      else action = { type: 'NODE', destinationId: built[tr.to].frame.id, navigation: 'NAVIGATE', transition: DISSOLVE, preserveScrollPosition: false };
      const click = { trigger: { type: 'ON_CLICK' }, actions: [action] };
      // Instance nút: giữ tương tác hover của component, thêm click
      let reactions = [click];
      if (target.type === 'INSTANCE') {
        const main = await target.getMainComponentAsync();
        const mainId = main && main.id;
        const entry = Object.values(compSets).find((c) => c.variants.Default.id === mainId);
        if (entry) reactions = entry.hoverReactions.filter((r) => r.trigger.type === 'ON_HOVER').concat([click]);
      }
      try { await target.setReactionsAsync(reactions); stats.links++; done.add(target.id); }
      catch (e) { missing.push(`${t.text} (bước ${indexOf[tr.from]})`); }
    }
    // Menu: bấm ra ngoài menu là đóng (lớp trong suốt nằm dưới menu, phủ kín khung nhìn)
    for (const s of steps) {
      if (!overlays.has(s.id) || s.modal.kind !== 'menu') continue;
      const f = built[s.id].frame;
      const bg = hotspot(f, 'Bấm ra ngoài để đóng', 0, 0, f.width, f.height, 0);
      try { await bg.setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'CLOSE' }] }]); } catch (e) { /* bỏ qua */ }
    }
    const first = steps.find((s) => !overlays.has(s.id));
    if (first) {
      const fid = built[first.id].frame.id;
      const flows = (figma.currentPage.flowStartingPoints || []).filter((f) => f.nodeId !== fid);
      figma.currentPage.flowStartingPoints = flows.concat([{ nodeId: fid, name: data.title || 'Flow' }]);
    }
  }
  return { nodes, missing };
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'build') {
    resetStats();
    missingFonts.clear();
    for (const k of Object.keys(compSets)) delete compSets[k];
    Object.assign(shared, { enabled: false, eligible: new Set(), mains: {}, names: {}, section: null });
    try {
      if (!fontIndex) await buildFontIndex();
      const data = normalize(msg.data, msg.name);
      const { nodes, missing } = await buildRecording(data, msg.options);
      figma.currentPage.selection = nodes;
      figma.viewport.scrollAndZoomIntoView(nodes);
      figma.ui.postMessage({ type: 'done', stats, missingFonts: [...missingFonts], missingLinks: missing, page: figma.currentPage.name });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', text: `${String(e && e.message || e)} (plugin bản ${VERSION})` });
    }
  }
  if (msg.type === 'resize') figma.ui.resize(360, Math.min(720, Math.max(300, msg.height)));
};
