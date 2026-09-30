// Đọc DOM đã render thành cây dữ liệu để dựng Figma (figmaData).
(() => {
  if (window.W2F) return;
  const HOST_ID = 'w2f-recorder-host';
  const FREEZE_ID = 'w2f-freeze';
  const mediaCache = new Map();
  let refSeq = 0;

  const isOurs = (el) => el.id === HOST_ID || el.id === FREEZE_ID;

  // ---------- Transform (xoay, co giãn) ----------
  // Đo layout khi đã tạm bỏ transform, và ghi lại transform để plugin áp lại đúng góc xoay.
  let xfMap = new Map();

  function transformOf(cs) {
    if (!cs.transform || cs.transform === 'none') return null;
    let m;
    try { m = new DOMMatrix(cs.transform); } catch (e) { return null; }
    const eps = 1e-4;
    // Chỉ dịch chuyển: khung đo được đã đúng, không cần xử lý
    if (Math.abs(m.a - 1) < eps && Math.abs(m.b) < eps && Math.abs(m.c) < eps && Math.abs(m.d - 1) < eps) return null;
    const [ox, oy] = cs.transformOrigin.split(' ').map(parseFloat);
    return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f, ox: ox || 0, oy: oy || 0 };
  }

  function collectTransforms(els) {
    const map = new Map();
    for (const el of els) {
      if (el.ownerSVGElement || isOurs(el) || el.closest('#' + HOST_ID)) continue;
      const xf = transformOf(getComputedStyle(el));
      if (xf) map.set(el, xf);
    }
    return map;
  }

  async function neutralized(map, fn) {
    const saved = [];
    for (const el of map.keys()) {
      saved.push([el, el.style.getPropertyValue('transform'), el.style.getPropertyPriority('transform')]);
      el.style.setProperty('transform', 'none', 'important');
    }
    try { return await fn(); }
    finally {
      for (const [el, v, p] of saved) {
        if (v) el.style.setProperty('transform', v, p); else el.style.removeProperty('transform');
      }
    }
  }

  function isVisible(cs) {
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && parseFloat(cs.opacity) > 0;
  }

  function loadMedia(url) {
    if (!url) return Promise.resolve(null);
    if (!mediaCache.has(url)) {
      mediaCache.set(url, chrome.runtime.sendMessage({ type: 'fetchImage', url }).catch(() => null));
    }
    return mediaCache.get(url);
  }

  function sizedSvg(text, w, h) {
    try {
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const svg = doc.documentElement;
      if (svg.nodeName.toLowerCase() !== 'svg') return null;
      if (!svg.getAttribute('viewBox')) {
        const ow = parseFloat(svg.getAttribute('width')), oh = parseFloat(svg.getAttribute('height'));
        if (ow && oh) svg.setAttribute('viewBox', `0 0 ${ow} ${oh}`);
      }
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      return new XMLSerializer().serializeToString(svg);
    } catch (e) { return null; }
  }

  // ---------- Ảnh nền ----------
  const firstOf = (v) => splitTopComma(v)[0] || '';
  function splitTopComma(str) {
    const out = []; let depth = 0, cur = '';
    for (const ch of str || '') {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function svgNaturalSize(text) {
    try {
      const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
      const w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
      if (w && h) return { w, h };
      const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(parseFloat);
      if (vb.length === 4 && vb[2] && vb[3]) return { w: vb[2], h: vb[3], ratioOnly: true };
    } catch (e) { /* SVG lỗi */ }
    return null;
  }

  async function imageNaturalSize(dataUrl) {
    const img = new Image();
    img.src = dataUrl;
    try { await img.decode(); return { w: img.naturalWidth, h: img.naturalHeight }; } catch (e) { return null; }
  }

  async function rasterizeSvg(text, w, h) {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * 2)); c.height = Math.max(1, Math.round(h * 2));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }

  // Kích thước một ô ảnh nền theo background-size
  function tileSize(sizeVal, elW, elH, nat) {
    const nw = nat ? nat.w : elW, nh = nat ? nat.h : elH;
    const ratio = nw && nh ? nw / nh : 1;
    if (sizeVal === 'cover' || sizeVal === 'contain') {
      const k = sizeVal === 'cover' ? Math.max(elW / nw, elH / nh) : Math.min(elW / nw, elH / nh);
      return { w: nw * k, h: nh * k };
    }
    const parts = sizeVal.split(/\s+/);
    const one = (v, full) => (v === 'auto' || v === undefined ? null : v.endsWith('%') ? parseFloat(v) / 100 * full : parseFloat(v));
    let w = one(parts[0], elW), h = one(parts[1], elH);
    if (w === null && h === null) { w = nat && !nat.ratioOnly ? nw : (nat ? elW : elW); h = nat && !nat.ratioOnly ? nh : w / ratio; }
    else if (w === null) w = h * ratio;
    else if (h === null) h = w / ratio;
    return { w, h };
  }

  function tileOffset(posVal, elW, elH, tw, th) {
    const parts = (posVal || '0% 0%').split(/\s+/);
    const one = (v, free) => (v === undefined ? 0 : v.endsWith('%') ? parseFloat(v) / 100 * free : parseFloat(v) || 0);
    return { x: one(parts[0], elW - tw), y: one(parts[1], elH - th) };
  }

  async function backgroundLayer(el, cs, box) {
    const m = firstOf(cs.backgroundImage).match(/url\(["']?(.*?)["']?\)$/);
    if (!m) return null;
    const media = await loadMedia(m[1]);
    if (!media || media.error) return null;
    const repeatVal = firstOf(cs.backgroundRepeat);
    const repeat = !/^no-repeat( no-repeat)?$/.test(repeatVal);
    const sizeVal = firstOf(cs.backgroundSize), posVal = firstOf(cs.backgroundPosition);
    if (media.svg) {
      const nat = svgNaturalSize(media.svg);
      const t = tileSize(sizeVal, box.w, box.h, nat);
      if (!(t.w > 0 && t.h > 0)) return null;
      const off = tileOffset(posVal, box.w, box.h, t.w, t.h);
      if (!repeat) {
        const svg = sizedSvg(media.svg, t.w, t.h);
        return svg ? { kind: 'svg', svg, x: off.x, y: off.y, w: t.w, h: t.h } : null;
      }
      try {
        return { kind: 'image', data: await rasterizeSvg(media.svg, t.w, t.h), repeat: true, x: off.x, y: off.y, w: t.w, h: t.h, natW: t.w * 2, natH: t.h * 2 };
      } catch (e) { return null; }
    }
    if (media.dataUrl) {
      const nat = await imageNaturalSize(media.dataUrl);
      const t = tileSize(sizeVal, box.w, box.h, nat);
      const off = tileOffset(posVal, box.w, box.h, t.w, t.h);
      return { kind: 'image', data: media.dataUrl, repeat, size: sizeVal, x: off.x, y: off.y, w: t.w, h: t.h, natW: nat ? nat.w : t.w, natH: nat ? nat.h : t.h };
    }
    return null;
  }

  function boxOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  }

  // Tách chuỗi thành các hàm cấp ngoài cùng: "a(..) b(..)" → [{name, args}]
  function splitFunctions(str) {
    const out = [];
    let i = 0;
    while (i < str.length) {
      const m = /[\w-]+\(/y;
      m.lastIndex = i;
      const hit = m.exec(str);
      if (!hit) { i++; continue; }
      let depth = 1, j = m.lastIndex;
      while (j < str.length && depth) { if (str[j] === '(') depth++; else if (str[j] === ')') depth--; j++; }
      out.push({ name: hit[0].slice(0, -1), args: str.slice(m.lastIndex, j - 1) });
      i = j;
    }
    return out;
  }

  // Tách filter: bóng đổ theo hình, làm mờ, và các bộ lọc Figma không có. Bỏ bộ lọc riêng của trình duyệt (-opera-..., -webkit-...)
  function filterOf(cs) {
    if (!cs.filter || cs.filter === 'none') return {};
    const fns = splitFunctions(cs.filter).filter((f) => !f.name.startsWith('-'));
    const out = {};
    const shadows = [];
    for (const f of fns) {
      if (f.name === 'drop-shadow') {
        const cm = f.args.match(/((?:rgba?|color|hsla?)\([^)]*\)|#[0-9a-f]+)/i);
        const rest = cm ? f.args.replace(cm[1], '') : f.args;
        const nums = (rest.match(/-?[\d.]+px/g) || []).map(parseFloat);
        shadows.push({ color: cm ? cm[1] : 'rgba(0, 0, 0, 1)', x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0 });
      } else if (f.name === 'blur') out.blur = parseFloat(f.args) || 0;
      else if (!/^(brightness|contrast|saturate|grayscale|sepia|hue-rotate|invert|opacity)$/.test(f.name) || !isIdentity(f)) {
        (out.other = out.other || []).push(`${f.name}(${f.args})`);
      }
    }
    if (shadows.length) out.dropShadows = shadows;
    if (out.blur !== undefined || out.other) out.filter = fns.filter((f) => f.name !== 'drop-shadow').map((f) => `${f.name}(${f.args})`).join(' ') || null;
    return out;
  }
  function isIdentity(f) {
    const v = parseFloat(f.args);
    if (/^(brightness|contrast|saturate|opacity)$/.test(f.name)) return v === 1 || f.args.trim() === '100%';
    return !v;
  }

  function styleOf(cs) {
    return {
      bg: cs.backgroundColor,
      bgImage: cs.backgroundImage !== 'none' ? cs.backgroundImage : null,
      bgSize: cs.backgroundSize,
      radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(parseFloat),
      border: ['Top', 'Right', 'Bottom', 'Left'].map((k) => ({
        w: parseFloat(cs['border' + k + 'Width']) || 0, c: cs['border' + k + 'Color'], s: cs['border' + k + 'Style'],
      })),
      shadow: cs.boxShadow !== 'none' ? cs.boxShadow : null,
      opacity: parseFloat(cs.opacity),
      clip: cs.overflowX !== 'visible' || cs.overflowY !== 'visible',
      blur: cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : null,
      transform: cs.transform !== 'none' ? cs.transform : null,
      ...(() => { const f = filterOf(cs); return { filter: f.filter || null, dropShadows: f.dropShadows, filterOther: f.other }; })(),
    };
  }

  function fontOf(cs) {
    return {
      family: cs.fontFamily, size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400,
      italic: cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique'), color: cs.color,
      lineHeight: cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight),
      letterSpacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing),
      align: cs.textAlign, transform: cs.textTransform, decoration: cs.textDecorationLine, whiteSpace: cs.whiteSpace,
    };
  }

  function normalizeText(t, ws) {
    if (/^(pre|pre-wrap|break-spaces)$/.test(ws)) return t;
    if (ws === 'pre-line') return t.replace(/[ \t]+/g, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  function nameOf(el) {
    let n = el.tagName.toLowerCase();
    if (el.id) n += '#' + el.id;
    else if (el.classList && el.classList.length) n += '.' + [...el.classList].slice(0, 2).join('.');
    return n;
  }

  function inlineSvg(el) {
    const clone = el.cloneNode(true);
    const src = [el, ...el.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    src.forEach((s, i) => {
      const cs = getComputedStyle(s);
      const d = dst[i];
      if (!d.setAttribute) return;
      const fill = cs.getPropertyValue('fill');
      if (fill) d.setAttribute('fill', fill);
      for (const p of ['stroke', 'stroke-width', 'stop-color', 'stop-opacity']) {
        const v = cs.getPropertyValue(p);
        if (v && v !== 'none') d.setAttribute(p, v);
      }
      if (cs.opacity !== '1') d.setAttribute('opacity', cs.opacity);
    });
    const b = el.getBoundingClientRect();
    clone.setAttribute('width', b.width);
    clone.setAttribute('height', b.height);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return new XMLSerializer().serializeToString(clone);
  }

  async function walk(el) {
    if (isOurs(el)) return null;
    const cs = getComputedStyle(el);
    if (!isVisible(cs)) return null;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title'].includes(tag)) return null;

    const box = boxOf(el);
    // Phần tử ẩn cho trình đọc màn hình (visually-hidden): khung 1px có che nội dung
    if (box.w <= 1.5 && box.h <= 1.5 && (cs.overflow !== 'visible' || cs.clip !== 'auto' || cs.clipPath !== 'none')) return null;
    const node = { type: 'box', name: nameOf(el), box, style: styleOf(cs), children: [] };
    const ref = el.getAttribute('data-w2f-ref');
    if (ref) node.ref = ref;
    const xf = xfMap.get(el);
    if (xf) node.xf = xf;
    if (el.hasAttribute('data-w2f-moving')) node.moving = true;
    if (cs.position === 'fixed') node.fixed = true;

    if (tag === 'svg') { node.type = 'svg'; node.svg = inlineSvg(el); return node; }
    if (tag === 'img' || tag === 'video') {
      const url = tag === 'img' ? (el.currentSrc || el.src) : el.poster;
      const m = await loadMedia(url);
      if (m && m.svg) {
        const s = sizedSvg(m.svg, node.box.w, node.box.h);
        if (s) { node.type = 'svg'; node.svg = s; return node; }
      }
      node.type = 'image'; node.src = m && m.dataUrl || null; node.fit = cs.objectFit;
      return node;
    }
    if (tag === 'canvas') {
      node.type = 'image';
      try { node.src = el.toDataURL('image/png'); } catch (e) { node.src = null; }
      node.fit = 'fill';
      return node;
    }
    if (tag === 'iframe') { node.name = 'iframe (không đọc được nội dung)'; node.style.bg = 'rgb(235, 235, 235)'; return node; }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      let t = '';
      if (tag === 'select') t = el.selectedOptions[0] ? el.selectedOptions[0].text : '';
      else t = (el.type === 'password' ? '•'.repeat(el.value.length) : el.value) || el.placeholder || '';
      const skip = ['range', 'checkbox', 'radio', 'color', 'file', 'hidden'].includes(el.type);
      if (!skip && t) {
        const pl = parseFloat(cs.paddingLeft) || 0, pt = parseFloat(cs.paddingTop) || 0;
        const pr = parseFloat(cs.paddingRight) || 0, pb = parseFloat(cs.paddingBottom) || 0;
        const f = fontOf(cs);
        if (!el.value && tag !== 'select') {
          const ph = getComputedStyle(el, '::placeholder').color;
          if (ph) f.color = ph;
        }
        node.children.push({
          type: 'text', name: 'value', text: t, font: f,
          box: { x: node.box.x + pl, y: node.box.y + pt, w: Math.max(1, node.box.w - pl - pr), h: Math.max(1, node.box.h - pt - pb) },
          vcenter: tag !== 'textarea', lines: tag === 'textarea' ? 2 : 1,
        });
      }
      if (el.type === 'checkbox' || el.type === 'radio') node.checked = el.checked;
      if (el.type === 'range') node.range = { min: +el.min || 0, max: +el.max || 100, value: +el.value, accent: cs.accentColor };
      return node;
    }

    if (node.style.bgImage && /url\(/.test(node.style.bgImage)) {
      const layer = await backgroundLayer(el, cs, node.box);
      if (layer) node.style.bgLayer = layer;
    }

    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!child.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
        if (!rects.length) continue;
        const r = range.getBoundingClientRect();
        const f = fontOf(cs);
        const text = normalizeText(child.textContent, f.whiteSpace);
        if (!text) continue;
        node.children.push({
          type: 'text', name: text.slice(0, 40), text, font: f,
          box: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height },
          lines: new Set(rects.map((q) => Math.round(q.top))).size,
        });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const c = await walk(child);
        if (c) node.children.push(c);
      }
    }
    node.z = cs.zIndex === 'auto' ? 0 : parseInt(cs.zIndex, 10) || 0;
    node.children = node.children.map((n, i) => ({ n, i }))
      .sort((a, b) => (a.n.z || 0) - (b.n.z || 0) || a.i - b.i).map((o) => o.n);
    return node;
  }

  // ---------- Tìm phần tử tương tác để quét hover ----------
  const INTERACTIVE = 'a[href],button,[role=button],[role=link],[role=tab],[role=menuitem],[role=switch],summary,select,' +
    'input[type=button],input[type=submit],input[type=reset],input[type=checkbox],input[type=radio],label[for]';

  function labelOf(el) {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.alt || '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 40) || nameOf(el);
  }

  function findCandidates(limit) {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (out.length >= limit) break;
      if (el.closest('#' + HOST_ID)) continue;
      const cs = getComputedStyle(el);
      if (!isVisible(cs) || cs.pointerEvents === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const parentPointer = el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer';
      if (!(el.matches(INTERACTIVE) || (cs.cursor === 'pointer' && !parentPointer))) continue;
      out.push(el);
    }
    return out;
  }

  // Định danh ổn định của một phần tử: id, thuộc tính data-*, đường dẫn, hoặc vị trí trong cây DOM
  function identityOf(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const parts = [tag];
    const cls = [...el.classList].filter((c) => !/^(is-|has-)?(active|open|selected|hover|focus)/.test(c)).slice(0, 3);
    if (cls.length) parts.push('.' + cls.join('.'));
    const data = [...el.attributes].filter((a) => a.name.startsWith('data-') && !a.name.startsWith('data-w2f'))
      .map((a) => `[${a.name}=${a.value.slice(0, 40)}]`).sort();
    parts.push(...data);
    // Liên kết "#" hoặc "javascript:" không phân biệt được các phần tử với nhau
    const href = el.getAttribute('href');
    const usefulHref = href && href !== '#' && !/^javascript:/i.test(href);
    for (const a of ['href', 'for', 'aria-controls', 'name', 'type']) {
      const v = el.getAttribute(a);
      if (v && (a !== 'href' || usefulHref)) parts.push(`[${a}=${v.slice(0, 60)}]`);
    }
    if (!data.length && !usefulHref) {
      // Không có dấu hiệu riêng: dùng vị trí trong cây, tới tổ tiên gần nhất có id (tối đa 5 cấp)
      const path = [];
      let cur = el;
      for (let i = 0; cur && cur !== document.body && i < 5; i++) {
        if (cur.id) { path.unshift('#' + cur.id); break; }
        const p = cur.parentElement;
        const idx = p ? [...p.children].filter((c) => c.tagName === cur.tagName).indexOf(cur) + 1 : 1;
        path.unshift(`${cur.tagName.toLowerCase()}:${idx}`);
        cur = p;
      }
      parts.push('@' + path.join('>'));
    }
    return parts.join('');
  }

  function headingNow() {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth &&
        (!el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
    };
    const dlg = [...document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')].find(vis);
    const scope = dlg || document;
    const h = [...scope.querySelectorAll('h1,h2,h3,[role=heading]')].find(vis);
    return h ? h.innerText.trim().replace(/\s+/g, ' ').slice(0, 60) : null;
  }

  async function snapshot() {
    document.querySelectorAll('[data-w2f-ref]').forEach((el) => el.removeAttribute('data-w2f-ref'));
    const cands = findCandidates(60);
    const meta = cands.map((el) => {
      const ref = 'r' + (++refSeq);
      el.setAttribute('data-w2f-ref', ref);
      return { el, ref, label: labelOf(el), key: identityOf(el) };
    });

    xfMap = collectTransforms(document.body.querySelectorAll('*'));
    if (xfMap.size) await walk(document.body); // tải trước ảnh, để lúc bỏ transform đo thật nhanh
    const result = await neutralized(xfMap, () => measure(meta));
    xfMap = new Map();
    return result;
  }

  async function measure(meta) {
    const html = document.documentElement, body = document.body;
    const rootCs = getComputedStyle(html), bodyCs = getComputedStyle(body);
    const clear = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
    const bg = !clear(bodyCs.backgroundColor) ? bodyCs.backgroundColor : !clear(rootCs.backgroundColor) ? rootCs.backgroundColor : 'rgb(255, 255, 255)';
    const page = {
      w: Math.max(html.scrollWidth, body.scrollWidth, innerWidth),
      h: Math.max(html.scrollHeight, body.scrollHeight, innerHeight),
      bg, bgImage: rootCs.backgroundImage !== 'none' ? rootCs.backgroundImage : null,
    };
    const root = await walk(body);
    // Các lớp modal (đánh dấu khi phát hiện modal mở), giữ toạ độ để dựng overlay
    const layers = [];
    let backdrop = null;
    for (const el of document.querySelectorAll('[data-w2f-modal]')) {
      const t = await walk(el);
      if (t) layers.push(t);
      if (el.matches('dialog') && el.matches(':modal')) {
        const bd = getComputedStyle(el, '::backdrop').backgroundColor;
        if (bd && bd !== 'rgba(0, 0, 0, 0)') backdrop = bd;
      }
    }
    const modal = layers.length ? { layers, backdrop, scroll: { x: scrollX, y: scrollY }, viewport: { w: innerWidth, h: innerHeight } } : null;
    const candidates = [];
    for (const m of meta) candidates.push({ ref: m.ref, key: m.key, label: m.label, base: await walk(m.el) });
    return { url: location.href, title: document.title, heading: headingNow(), page, root, modal, candidates };
  }

  async function serializeRef(ref) {
    const el = document.querySelector(`[data-w2f-ref="${ref}"]`);
    if (!el) return null;
    const scope = [el, ...el.querySelectorAll('*')];
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) scope.push(p);
    xfMap = collectTransforms(scope);
    const out = await neutralized(xfMap, () => walk(el));
    xfMap = new Map();
    return out;
  }

  window.W2F = { snapshot, serializeRef, labelOf, headingNow, HOST_ID, FREEZE_ID };
})();
