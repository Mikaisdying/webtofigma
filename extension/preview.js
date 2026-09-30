// Vẽ preview SVG từ chính dữ liệu dùng để dựng Figma, nên preview phản ánh đúng những gì plugin sẽ dựng.
function renderPreview(step) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const r1 = (v) => Math.round(v * 10) / 10;
  const clear = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const defs = [];
  let gid = 0;

  function splitTop(str) {
    const out = []; let depth = 0, cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function gradient(layer, b) {
    const m = layer.match(/^(?:repeating-)?(linear|radial)-gradient\((.*)\)$/i);
    if (!m) return null;
    const parts = splitTop(m[2]);
    const id = 'g' + (++gid);
    let open;
    if (m[1] === 'linear') {
      let deg = 180;
      const sides = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to bottom right': 135, 'to bottom left': 225, 'to top left': 315 };
      if (/^-?[\d.]+deg$/.test(parts[0])) deg = parseFloat(parts.shift());
      else if (/^to /.test(parts[0])) deg = sides[parts.shift()] ?? 180;
      const rad = (deg - 90) * Math.PI / 180, dx = Math.cos(rad) / 2, dy = Math.sin(rad) / 2;
      open = `<linearGradient id="${id}" x1="${r1(0.5 - dx)}" y1="${r1(0.5 - dy)}" x2="${r1(0.5 + dx)}" y2="${r1(0.5 + dy)}">`;
    } else {
      let cx = 0.5, cy = 0.5, shape = '';
      if (!/^(rgb|color|#|hsl)/.test(parts[0])) {
        shape = parts.shift();
        const at = shape.match(/at\s+([-\d.]+)%\s+([-\d.]+)%/);
        if (at) { cx = parseFloat(at[1]) / 100; cy = parseFloat(at[2]) / 100; }
      }
      // Bán kính theo kiểu farthest-corner (mặc định của CSS): r gấp √2 khoảng cách tới cạnh xa nhất
      const dx = Math.max(cx, 1 - cx), dy = Math.max(cy, 1 - cy);
      const circle = /circle/.test(shape);
      let rx = dx * Math.SQRT2, ry = dy * Math.SQRT2;
      if (/closest-side/.test(shape)) { rx = Math.min(cx, 1 - cx); ry = Math.min(cy, 1 - cy); }
      else if (/farthest-side/.test(shape)) { rx = dx; ry = dy; }
      if (circle && b && b.w && b.h) {
        const px = /closest-side/.test(shape) ? Math.min(cx * b.w, (1 - cx) * b.w, cy * b.h, (1 - cy) * b.h)
          : /farthest-side/.test(shape) ? Math.max(dx * b.w, dy * b.h) : Math.hypot(dx * b.w, dy * b.h);
        rx = px / b.w; ry = px / b.h;
      } else if (circle) { const r = Math.max(rx, ry); rx = ry = r; }
      const k = rx ? ry / rx : 1;
      open = `<radialGradient id="${id}" cx="${r1(cx * 100) / 100}" cy="${r1(cy * 100) / 100}" r="${r1(rx * 100) / 100}" gradientTransform="translate(${cx} ${cy}) scale(1 ${r1(k * 100) / 100}) translate(${-cx} ${-cy})">`;
    }
    const stops = parts.map((p, i) => {
      const mm = p.match(/^(.*\))\s*([-\d.]+%)?/) || p.match(/^(\S+)\s*([-\d.]+%)?/);
      const color = mm ? mm[1] : p;
      const off = mm && mm[2] ? mm[2] : `${Math.round(i / Math.max(1, parts.length - 1) * 100)}%`;
      return `<stop offset="${off}" stop-color="${esc(color)}"/>`;
    }).join('');
    defs.push(open + stops + (m[1] === 'linear' ? '</linearGradient>' : '</radialGradient>'));
    return `url(#${id})`;
  }

  function bgLayer(b, L) {
    const id = 'b' + (++gid);
    defs.push(`<clipPath id="${id}"><rect x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}"/></clipPath>`);
    const x = r1(b.x + L.x), y = r1(b.y + L.y), w = r1(L.w), h = r1(L.h);
    if (L.kind === 'svg') {
      const inner = L.svg.startsWith('asset:') ? `<image href="${L.svg}" x="${x}" y="${y}" width="${w}" height="${h}"/>` : L.svg.replace(/^\s*(<\?xml[^>]*>\s*)?<svg\b/, `<svg x="${x}" y="${y}"`);
      return `<g clip-path="url(#${id})">${inner}</g>`;
    }
    if (L.repeat) {
      const pid = 'p' + (++gid);
      defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}"><image href="${L.data}" width="${w}" height="${h}" preserveAspectRatio="none"/></pattern>`);
      return `<rect x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}" fill="url(#${pid})"/>`;
    }
    return `<g clip-path="url(#${id})"><image href="${L.data}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none"/></g>`;
  }

  function rectAttrs(b, st) {
    const rad = st && st.radius ? Math.min(st.radius[0] || 0, b.w / 2, b.h / 2) : 0;
    return `x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(Math.max(0, b.w))}" height="${r1(Math.max(0, b.h))}"${rad ? ` rx="${r1(rad)}"` : ''}`;
  }

  function box(n) {
    const b = n.box, st = n.style || {};
    let s = '';
    if (!clear(st.bg)) s += `<rect ${rectAttrs(b, st)} fill="${esc(st.bg)}"/>`;
    if (st.bgImage) {
      for (const layer of splitTop(st.bgImage).reverse()) {
        if (/^url\(/.test(layer)) {
          if (st.bgLayer) s += bgLayer(b, st.bgLayer);
          else if (st.bgImageData) s += `<image href="${st.bgImageData}" x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}" preserveAspectRatio="xMidYMid slice"/>`;
        } else if (/conic-gradient/.test(layer)) {
          const rad = st.radius ? Math.min(st.radius[0] || 0, b.w / 2, b.h / 2) : 0;
          s += `<foreignObject x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}"><div xmlns="http://www.w3.org/1999/xhtml" style="${esc(`width:100%;height:100%;border-radius:${rad}px;background:${layer}`)}"></div></foreignObject>`;
        } else {
          const g = gradient(layer, b);
          if (g) s += `<rect ${rectAttrs(b, st)} fill="${g}"/>`;
        }
      }
    }
    const side = (st.border || []).find((x) => x.w > 0 && x.s !== 'none' && x.s !== 'hidden' && !clear(x.c));
    let kids = (n.children || []).map(node).join('');
    if (st.clip && kids) {
      const id = 'c' + (++gid);
      defs.push(`<clipPath id="${id}"><rect ${rectAttrs(b, st)}/></clipPath>`);
      kids = `<g clip-path="url(#${id})">${kids}</g>`;
    }
    s += kids;
    if (side) {
      const h = side.w / 2;
      s += `<rect ${rectAttrs({ x: b.x + h, y: b.y + h, w: b.w - side.w, h: b.h - side.w }, st)} fill="none" stroke="${esc(side.c)}" stroke-width="${side.w}"${side.s === 'dashed' ? ` stroke-dasharray="${side.w * 3} ${side.w * 2}"` : ''}/>`;
    }
    if (st.opacity < 1) s = `<g opacity="${st.opacity}">${s}</g>`;
    return s;
  }

  function text(n) {
    const b = n.box, f = n.font;
    const css = [
      `font-family:${f.family}`, `font-size:${f.size}px`, `font-weight:${f.weight}`, `color:${f.color}`,
      f.italic ? 'font-style:italic' : '', f.lineHeight ? `line-height:${f.lineHeight}px` : '',
      f.letterSpacing ? `letter-spacing:${f.letterSpacing}px` : '', `text-align:${f.align}`,
      f.transform && f.transform !== 'none' ? `text-transform:${f.transform}` : '',
      f.decoration && f.decoration !== 'none' ? `text-decoration:${f.decoration}` : '',
      (n.lines || 1) > 1 ? 'white-space:normal' : 'white-space:nowrap', 'margin:0', 'overflow:visible',
      n.vcenter ? `display:flex;align-items:center;height:${r1(b.h)}px` : '',
    ].filter(Boolean).join(';');
    return `<foreignObject x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w + 2)}" height="${r1(b.h + 4)}"><div xmlns="http://www.w3.org/1999/xhtml" style="${esc(css)}">${esc(n.text)}</div></foreignObject>`;
  }

  function image(n) {
    const b = n.box;
    const frame = box(Object.assign({}, n, { children: [] })); // nền, viền, bo góc của khung ảnh
    if (!n.src) return `<rect ${rectAttrs(b, n.style)} fill="#e5e5e5"/>` + frame;
    const par = n.fit === 'contain' || n.fit === 'scale-down' ? 'xMidYMid meet' : n.fit === 'fill' ? 'none' : 'xMidYMid slice';
    return frame + `<image href="${n.src}" x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}" preserveAspectRatio="${par}"/>`;
  }

  function svg(n) {
    const b = n.box;
    if (n.svg.startsWith('asset:')) return `<image href="${n.svg}" x="${r1(b.x)}" y="${r1(b.y)}" width="${r1(b.w)}" height="${r1(b.h)}"/>`;
    return n.svg.replace(/^\s*(<\?xml[^>]*>\s*)?<svg\b/, `<svg x="${r1(b.x)}" y="${r1(b.y)}"`);
  }

  function node(n) {
    if (!n) return '';
    let out = n.type === 'text' ? text(n) : n.type === 'image' ? image(n) : n.type === 'svg' ? svg(n) : box(n);
    const ds = n.style && n.style.dropShadows;
    if (ds && ds.length) {
      const fid = 'f' + (++gid);
      defs.push(`<filter id="${fid}" x="-20%" y="-20%" width="140%" height="140%">` +
        ds.map((d) => `<feDropShadow dx="${d.x}" dy="${d.y}" stdDeviation="${d.blur / 2}" flood-color="${esc(d.color)}"/>`).slice(0, 1).join('') + '</filter>');
      out = `<g filter="url(#${fid})">${out}</g>`;
    }
    if (!n.xf) return out;
    // Xoay/co giãn quanh tâm transform-origin, giống trình duyệt
    const x = n.xf, px = r1(n.box.x + x.ox), py = r1(n.box.y + x.oy);
    return `<g transform="translate(${px} ${py}) matrix(${x.a} ${x.b} ${x.c} ${x.d} ${x.e} ${x.f}) translate(${-px} ${-py})">${out}</g>`;
  }

  const p = step.page;
  const W = Math.round(p.w), H = Math.round(p.h);
  let bg = `<rect width="${W}" height="${H}" fill="${esc(p.bg)}"/>`;
  if (p.bgImage) for (const layer of splitTop(p.bgImage).reverse()) { const g = gradient(layer); if (g) bg += `<rect width="${W}" height="${H}" fill="${g}"/>`; }
  const body = node(step.root);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs.join('')}</defs>${bg}${body}</svg>`;
}
