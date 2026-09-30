(() => {
  if (window.__w2fContent) return;
  window.__w2fContent = true;
  const { HOST_ID, FREEZE_ID } = window.W2F;
  let rec = null;
  let host = null, ui = null;

  const send = (m) => chrome.runtime.sendMessage(m).catch(() => null);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Nhận lệnh từ background ----------
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    (async () => {
      switch (msg.type) {
        case 'ping': return { ok: true };
        case 'viewport': return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };
        case 'state': setState(msg.rec); return {};
        case 'freeze': freeze(msg.on); return {};
        case 'stabilize': return await stabilize(msg.maxMs || 5000);
        case 'parkPoint': {
          if (!ui) return null;
          const el = ui.panel.hidden ? ui.pill : ui.panel;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        case 'snapshot': return await window.W2F.snapshot();
        case 'serializeRef': return await window.W2F.serializeRef(msg.ref);
        case 'download': download(msg.json, msg.filename); return {};
      }
      return null;
    })().then(reply, (e) => reply({ error: String(e) }));
    return true;
  });

  // ---------- Hiệu ứng ----------
  // Hiệu ứng có hồi kết: nhảy tới trạng thái cuối. Hiệu ứng lặp vô hạn: dừng ở khung hình đầu, chạy tiếp sau khi chụp.
  let pausedAnims = [];
  function finishAnimations() {
    for (const a of document.getAnimations()) {
      try {
        if (pausedAnims.some(([p]) => p === a)) continue;
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        if (t && t.endTime !== Infinity && a.playState !== 'finished') a.finish();
        else if (a.playState === 'running') {
          pausedAnims.push([a, a.currentTime]);
          a.pause();
          a.currentTime = 0;
        }
      } catch (e) { /* bỏ qua hiệu ứng không điều khiển được */ }
    }
  }

  function freeze(on) {
    let s = document.getElementById(FREEZE_ID);
    if (on && !s) {
      s = document.createElement('style');
      s.id = FREEZE_ID;
      s.textContent = '*,*::before,*::after{transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}';
      document.documentElement.appendChild(s);
      finishAnimations();
    } else if (!on && s) {
      s.remove();
      for (const [a, t] of pausedAnims) { try { a.currentTime = t; a.play(); } catch (e) { /* đã bị huỷ */ } }
      pausedAnims = [];
    }
  }

  // ---------- Chờ trang ổn định trước khi chụp ----------
  // Đo vị trí các phần tử nhiều lần cách nhau 150ms. Phần tử đang trượt/giãn một chiều là "chưa xong";
  // phần tử đổi chiều chuyển động (đung đưa, lắc lư bằng JavaScript) được coi là chuyển động liên tục và bỏ qua.
  function sampleRects() {
    const map = new Map();
    let n = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (n++ > 4000) break;
      if (el.id === HOST_ID || el.id === FREEZE_ID) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      map.set(el, [r.left, r.top, r.width, r.height]);
    }
    return map;
  }

  async function waitMedia(ms) {
    const pending = [...document.images].filter((img) => !img.complete && img.getBoundingClientRect().width > 0);
    const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
    await Promise.race([
      Promise.all([fonts, ...pending.map((img) => new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); }))]),
      sleep(ms),
    ]);
  }

  async function stabilize(maxMs) {
    const start = Date.now();
    await waitMedia(Math.min(2000, maxMs));
    const hist = new Map(); // phần tử -> { last delta, đổi chiều? }
    let prev = sampleRects();
    let calm = 0;
    while (Date.now() - start < maxMs) {
      finishAnimations(); // hiệu ứng mới sinh ra trong lúc chờ
      await sleep(150);
      const cur = sampleRects();
      let settling = cur.size !== prev.size;
      for (const [el, r] of cur) {
        const p = prev.get(el);
        if (!p) continue;
        const d = r.map((v, i) => Math.round((v - p[i]) * 2) / 2);
        const moved = d.some((v) => v !== 0);
        const h = hist.get(el) || { last: null, osc: false };
        if (moved) {
          if (h.last && d.some((v, i) => v && h.last[i] && Math.sign(v) !== Math.sign(h.last[i]))) h.osc = true;
          h.last = d;
          if (!h.osc) settling = true;
        }
        hist.set(el, h);
      }
      prev = cur;
      calm = settling ? 0 : calm + 1;
      if (calm >= 2) return { stable: true, waited: Date.now() - start, moving: markMoving(hist) };
    }
    return { stable: false, waited: Date.now() - start, moving: markMoving(hist) };
  }

  // Đánh dấu phần tử chuyển động liên tục để không tính vị trí của chúng khi so sánh hai màn
  function markMoving(hist) {
    document.querySelectorAll('[data-w2f-moving]').forEach((el) => el.removeAttribute('data-w2f-moving'));
    let n = 0;
    for (const [el, h] of hist) if (h.osc && el.isConnected) { el.setAttribute('data-w2f-moving', ''); n++; }
    return n;
  }

  function download(json, filename) {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ---------- Phát hiện thay đổi sau click ----------
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.left >= innerWidth) return false;
    return !el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }

  const MENU_SEL = '[role=menu],[role=listbox],[popover],[data-w2f-menu]';

  function signature() {
    const vpArea = innerWidth * innerHeight;
    const dialogs = new Set(), menus = new Set(), floats = new Set();
    for (const el of document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')) {
      if (visible(el)) dialogs.add(el);
    }
    for (const el of document.querySelectorAll(MENU_SEL)) if (visible(el) && !dialogs.has(el)) menus.add(el);
    for (const c of document.querySelectorAll('[aria-expanded=true][aria-controls]')) {
      const t = document.getElementById(c.getAttribute('aria-controls'));
      if (t && visible(t)) menus.add(t);
    }
    for (const el of document.body.querySelectorAll('*')) {
      if (el.id === HOST_ID) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (!visible(el) || parseFloat(cs.opacity) <= 0.05) continue;
      if (cs.position === 'fixed' && area >= vpArea * 0.25) dialogs.add(el);
      else if (area >= 600 && area < vpArea * 0.25) floats.add(el);
    }
    const headings = [...document.querySelectorAll('h1,h2,h3,[role=heading]')]
      .filter((h) => !h.closest('#' + HOST_ID) && visible(h))
      .map((h) => h.innerText.trim()).filter(Boolean).slice(0, 12);
    const text = (document.body.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return { url: location.href, dialogs, menus, floats, headings, text };
  }

  function titleOf(d) {
    const h = d.querySelector('h1,h2,h3,[role=heading]');
    const t = (h && h.innerText) || d.getAttribute('aria-label') || d.innerText || '';
    return t.trim().replace(/\s+/g, ' ').slice(0, 50) || null;
  }

  const outermost = (list) => list.filter((d) => !list.some((o) => o !== d && o.contains(d)));
  function markLayers(list, menu) {
    document.querySelectorAll('[data-w2f-modal]').forEach((el) => el.removeAttribute('data-w2f-modal'));
    for (const d of outermost(list)) {
      d.setAttribute('data-w2f-modal', '');
      if (menu) d.setAttribute('data-w2f-menu', '');
    }
  }

  function classify(a, b, clicked) {
    const opened = [...b.dialogs].filter((d) => !a.dialogs.has(d));
    const closed = [...a.dialogs].filter((d) => !b.dialogs.has(d));
    if (opened.length) {
      markLayers(opened, false);
      const main = opened.find((d) => d.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]')) || opened[0];
      return { kind: 'modal-open', title: titleOf(main) };
    }
    if (closed.length) return { kind: 'modal-close', title: b.headings[0] || null };
    if (a.url !== b.url) return { kind: 'screen', title: b.headings[0] || null };
    if (a.headings.join('|') !== b.headings.join('|')) return { kind: 'screen', title: b.headings[0] || null };
    // Menu, danh sách thả xuống, popup nhỏ vừa hiện
    const newMenus = [...b.menus].filter((m) => !a.menus.has(m));
    const newFloats = [...b.floats].filter((f) => !a.floats.has(f) && !(clicked && f.contains(clicked)));
    const opener = clicked && clicked.closest('[aria-expanded]');
    if (newMenus.length || newFloats.length) {
      const layers = newMenus.length ? newMenus : newFloats;
      markLayers(layers, true);
      const label = (opener && window.W2F.labelOf(opener)) || titleOf(outermost(layers)[0]);
      return { kind: 'menu-open', title: label };
    }
    const closedMenus = [...a.menus].filter((m) => !b.menus.has(m) && !visible(m));
    if (closedMenus.length) return { kind: 'menu-close', title: b.headings[0] || null };
    const A = new Set(a.text), B = new Set(b.text);
    let changed = 0;
    for (const t of B) if (!A.has(t)) changed++;
    for (const t of A) if (!B.has(t)) changed++;
    const ratio = changed / Math.max(1, A.size + B.size);
    if (changed >= 3 && ratio > 0.35) return { kind: 'screen', title: b.headings[0] || null };
    return { none: true, why: changed ? `chữ chỉ đổi ${Math.round(ratio * 100)}%, không có tiêu đề/modal/menu mới` : 'không thấy thay đổi nào' };
  }

  function relevantMutation(m) {
    const t = m.target;
    if (m.type === 'attributes' && /^data-w2f-/.test(m.attributeName)) return false;
    if (t === host || (t.nodeType === 1 && (t.id === HOST_ID || t.id === FREEZE_ID))) return false;
    if (m.type === 'childList') {
      const nodes = [...m.addedNodes, ...m.removedNodes];
      if (nodes.length && nodes.every((n) => n.id === HOST_ID || n.id === FREEZE_ID || (n.tagName === 'A' && n.download))) return false;
    }
    return true;
  }

  function waitSettle() {
    return new Promise((resolve) => {
      const start = Date.now();
      let last = Date.now();
      const mo = new MutationObserver((list) => { if (list.some(relevantMutation)) last = Date.now(); });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const tick = setInterval(() => {
        const now = Date.now();
        if ((now - start >= 350 && now - last >= 350) || now - start >= 2500) {
          clearInterval(tick); mo.disconnect(); resolve();
        }
      }, 50);
    });
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    return {
      text: window.W2F.labelOf(el), tag: el.tagName.toLowerCase(),
      box: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height },
    };
  }

  const LATE_CHECK_MS = 5000;
  let busy = false, clickToken = 0;
  const ignored = (desc, reason) => { if (rec && rec.verbose) send({ type: 'ignored', desc, reason }); };

  document.addEventListener('click', async (e) => {
    if (!rec || !e.isTrusted) return;
    if (host && e.composedPath().includes(host)) return;
    const target = e.target.closest ? (e.target.closest('a,button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],input,label,summary,select') || e.target) : e.target;
    const desc = describe(target);
    if (rec.paused) return ignored(desc, 'đang tạm dừng');
    if (rec.stopping) return;
    if (busy) return ignored(desc, 'đang chờ kết quả của click trước');
    const token = ++clickToken;
    const t0 = Date.now();
    const before = signature();
    send({ type: 'click', desc });
    busy = true;
    await waitSettle();
    busy = false;
    let change = classify(before, signature(), target);
    if (change.none) {
      // Kiểm tra lại muộn: menu hoặc popup hiện chậm (tải dữ liệu, hiệu ứng JavaScript)
      await sleep(Math.max(0, LATE_CHECK_MS - (Date.now() - t0)));
      if (token !== clickToken) return ignored(desc, 'có click mới trước khi kịp kiểm tra lại');
      if (!rec || rec.paused) return;
      change = classify(before, signature(), target);
      if (!change.none) change.late = Math.round((Date.now() - t0) / 100) / 10;
    }
    if (change.none) return ignored(desc, change.why);
    send({ type: 'change', desc, change });
  }, true);

  // ---------- Box ghi log ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel, .pill { position: fixed; z-index: 2147483647;
      font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1d1d1f; }
    .panel { width: 310px; background: #fff; border: 1px solid #d8d8dc; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,.14); display: flex; flex-direction: column; }
    .panel.warn { border-color: #e2b100; box-shadow: 0 0 0 2px #f6d86b, 0 6px 24px rgba(0,0,0,.14); }
    .panel[hidden], .pill[hidden], .banner[hidden], .menu[hidden] { display: none; }
    header { display: flex; align-items: center; gap: 6px; padding: 8px 8px 8px 6px; border-bottom: 1px solid #ececef; position: relative; }
    header b { font-weight: 600; }
    .meta { color: #6e6e73; font-variant-numeric: tabular-nums; margin-left: auto; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #e0352b; flex: none; animation: pulse 1.4s ease-in-out infinite; }
    .paused .dot { background: #9a9aa0; animation: none; }
    @keyframes pulse { 50% { opacity: .35; } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    button { font: inherit; color: inherit; cursor: pointer; border-radius: 6px; }
    .icon { border: 0; background: none; width: 24px; height: 24px; color: #6e6e73; font-size: 16px; line-height: 1; padding: 0; }
    .icon:hover, .icon[aria-expanded=true] { background: #f0f0f2; }
    .banner { display: flex; gap: 8px; align-items: center; padding: 7px 12px; background: #fff6d6; color: #6b5200; border-bottom: 1px solid #f1dc8f; }
    .banner span { flex: 1; }
    .banner button, li .act { border: 1px solid #d8c26a; background: #fff; padding: 1px 8px; }
    ol { list-style: none; margin: 0; padding: 6px 0; max-height: 220px; overflow-y: auto; }
    li { padding: 3px 12px; }
    li.step span { font-weight: 600; }
    li.warn span { color: #b3261e; }
    li.note span, li.scan span, li.scan-done span, li.verbose span { color: #5c5c61; }
    li.verbose span { font-style: italic; }
    li .act { margin-left: 6px; }
    footer { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #ececef; }
    footer button { flex: 1; padding: 6px 6px; border: 1px solid #d8d8dc; background: #fff; }
    footer button:hover:not(:disabled) { background: #f5f5f7; }
    footer .pause.on { background: #1d1d1f; border-color: #1d1d1f; color: #fff; }
    footer .stop { background: #e0352b; border-color: #e0352b; color: #fff; }
    footer .stop:hover:not(:disabled) { background: #c42b22; }
    button:disabled { opacity: .5; cursor: default; }
    button:focus-visible { outline: 2px solid #0a66d8; outline-offset: 1px; }
    .menu { position: absolute; top: 36px; right: 8px; width: 210px; background: #fff; border: 1px solid #d8d8dc; border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,.16); padding: 4px; z-index: 2; }
    .menu button, .menu label { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: none; padding: 6px 8px; border-radius: 5px; }
    .menu button:hover:not(:disabled), .menu label:hover { background: #f0f0f2; }
    .menu button.confirm { background: #fde8e7; color: #b3261e; font-weight: 600; }
    .menu hr { border: 0; border-top: 1px solid #ececef; margin: 4px 2px; }
    .menu label { cursor: pointer; }
    .pill { display: flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid #d8d8dc;
      background: #fff; border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,.14); }
    .pill.warn { border-color: #e2b100; }
    .pill .open { display: flex; align-items: center; gap: 7px; border: 0; background: none; padding: 4px 10px 4px 4px; border-radius: 999px; }
    .pill .open:hover { background: #f0f0f2; }
    .move { cursor: grab; touch-action: none; display: grid; place-items: center; }
    .move svg { width: 14px; height: 14px; }
    .move:active, .dragging .move { cursor: grabbing; background: #e8e8ec; }
    .pill .move { border-radius: 999px; }
  `;

  const MOVE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/></svg>';
  const DEFAULT_POS = { right: 16, bottom: 16 };
  let dragPos = null; // vị trí tạm trong lúc kéo

  // Vị trí lưu theo khoảng cách tới mép phải/dưới, nên box và nút thu gọn luôn neo cùng một góc
  function applyPos() {
    if (!ui) return;
    const pos = dragPos || (rec && rec.pos) || DEFAULT_POS;
    for (const el of [ui.panel, ui.pill]) {
      if (el.hidden) continue;
      const w = el.offsetWidth, h = el.offsetHeight;
      el.style.right = Math.max(0, Math.min(pos.right, innerWidth - w)) + 'px';
      el.style.bottom = Math.max(0, Math.min(pos.bottom, innerHeight - h)) + 'px';
    }
  }

  function setupDrag(handle) {
    let start = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.focus(); // để dùng tiếp phím mũi tên sau khi bấm
      const el = handle.closest('.panel, .pill');
      const r = el.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom, el };
      handle.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      dragPos = { right: start.right - (e.clientX - start.x), bottom: start.bottom - (e.clientY - start.y) };
      applyPos();
    });
    const end = () => {
      if (!start) return;
      start.el.classList.remove('dragging');
      start = null;
      if (dragPos) commitPos();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    // Bàn phím: mũi tên di chuyển 10px, giữ Shift để di chuyển 50px
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 50 : 10;
      const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      if (!d) return;
      e.preventDefault();
      const el = handle.closest('.panel, .pill');
      const r = el.getBoundingClientRect();
      dragPos = { right: innerWidth - r.right + d[0], bottom: innerHeight - r.bottom + d[1] };
      applyPos();
      commitPos();
    });
  }

  function commitPos() {
    // Lưu vị trí đã giới hạn trong màn hình
    const el = ui.panel.hidden ? ui.pill : ui.panel;
    const pos = { right: parseFloat(el.style.right) || 0, bottom: parseFloat(el.style.bottom) || 0 };
    if (rec) rec.pos = pos;
    dragPos = null;
    send({ type: 'move', pos });
  }

  function buildUI() {
    host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${CSS}</style>
      <section class="panel" role="region" aria-label="Web → Figma: nhật ký ghi">
        <header>
          <button class="icon move" title="Kéo để di chuyển (hoặc dùng phím mũi tên)" aria-label="Di chuyển box">${MOVE_ICON}</button>
          <span class="dot"></span><b class="title">Đang ghi</b><span class="meta"></span>
          <button class="icon more" title="Thêm" aria-label="Thêm tuỳ chọn" aria-haspopup="menu" aria-expanded="false">⋯</button>
          <button class="icon collapse" title="Thu gọn" aria-label="Thu gọn">–</button>
          <div class="menu" role="menu" hidden>
            <button role="menuitem" data-act="deleteLast">Xoá bước cuối</button>
            <button role="menuitem" data-act="restart" data-confirm="Bấm lần nữa để làm lại">Làm lại từ đầu</button>
            <button role="menuitem" data-act="cancel" data-confirm="Bấm lần nữa để huỷ phiên">Huỷ phiên (không xuất file)</button>
            <hr>
            <label role="menuitemcheckbox"><input type="checkbox" class="verbose"> Log chi tiết</label>
          </div>
        </header>
        <div class="banner" hidden><span>Debug đang tắt: không quét được hover.</span><button class="reattach">Bật lại</button></div>
        <ol class="log" aria-live="polite"></ol>
        <footer><button class="shot">Chụp bước</button><button class="pause" title="Tạm dừng / tiếp tục (Alt+Shift+P)">Tạm dừng</button><button class="stop">Dừng</button></footer>
      </section>
      <div class="pill" hidden><button class="icon move" title="Kéo để di chuyển" aria-label="Di chuyển nút">${MOVE_ICON}</button><button class="open" aria-label="Mở nhật ký ghi"><span class="dot"></span><span class="pmeta"></span></button></div>`;
    const $ = (s) => shadow.querySelector(s);
    ui = {
      panel: $('.panel'), pill: $('.pill'), log: $('.log'), meta: $('.meta'), pmeta: $('.pmeta'), title: $('.title'),
      stop: $('.stop'), shot: $('.shot'), pause: $('.pause'), banner: $('.banner'), menu: $('.menu'), more: $('.more'), verbose: $('.verbose'),
    };
    $('.collapse').onclick = () => { closeMenu(); send({ type: 'collapse', value: true }); };
    $('.pill .open').onclick = () => send({ type: 'collapse', value: false });
    shadow.querySelectorAll('.move').forEach(setupDrag);
    ui.shot.onclick = () => send({ type: 'manual' });
    ui.pause.onclick = () => send({ type: 'pause', value: !rec.paused });
    ui.stop.onclick = () => { ui.stop.disabled = ui.shot.disabled = ui.pause.disabled = true; ui.stop.textContent = 'Đang xuất...'; send({ type: 'stop' }); };
    $('.reattach').onclick = () => send({ type: 'reattach' });
    ui.log.addEventListener('click', (e) => { if (e.target.classList.contains('act')) send({ type: 'reattach' }); });
    ui.more.onclick = () => (ui.menu.hidden ? openMenu() : closeMenu());
    ui.verbose.onchange = () => send({ type: 'verbose', value: ui.verbose.checked });
    // Thao tác xoá cần bấm hai lần trong 3 giây để xác nhận
    for (const b of ui.menu.querySelectorAll('button[data-act]')) {
      b.dataset.label = b.textContent;
      b.onclick = () => {
        if (b.dataset.confirm && !b.classList.contains('confirm')) {
          b.classList.add('confirm');
          b.textContent = b.dataset.confirm;
          clearTimeout(b._t);
          b._t = setTimeout(() => { b.classList.remove('confirm'); b.textContent = b.dataset.label; }, 3000);
          return;
        }
        closeMenu();
        send({ type: b.dataset.act });
      };
    }
    shadow.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ui.menu.hidden) { closeMenu(); ui.more.focus(); } });
    addEventListener('resize', applyPos);
    document.documentElement.appendChild(host);
  }

  function openMenu() { ui.menu.hidden = false; ui.more.setAttribute('aria-expanded', 'true'); const f = ui.menu.querySelector('button:not(:disabled)'); if (f) f.focus(); }
  function closeMenu() {
    if (!ui) return;
    ui.menu.hidden = true;
    ui.more.setAttribute('aria-expanded', 'false');
    for (const b of ui.menu.querySelectorAll('button[data-act]')) { b.classList.remove('confirm'); b.textContent = b.dataset.label; }
  }

  function renderMeta() {
    if (!rec || !ui) return;
    ui.meta.textContent = `${rec.stepCount} bước`;
    ui.pmeta.textContent = `${rec.paused ? 'Tạm dừng' : 'Đang ghi'} · ${rec.stepCount} bước`;
  }

  function render() {
    if (!ui) return;
    ui.panel.hidden = !!rec.collapsed;
    ui.pill.hidden = !rec.collapsed;
    if (rec.collapsed) closeMenu();
    const warn = !rec.debug && !rec.stopping;
    ui.panel.classList.toggle('warn', warn);
    ui.pill.classList.toggle('warn', warn);
    ui.banner.hidden = !warn;
    ui.panel.classList.toggle('paused', !!rec.paused);
    ui.pill.classList.toggle('paused', !!rec.paused);
    ui.title.textContent = rec.paused ? 'Đã tạm dừng' : 'Đang ghi';
    ui.pause.textContent = rec.paused ? 'Tiếp tục' : 'Tạm dừng';
    ui.pause.classList.toggle('on', !!rec.paused);
    ui.shot.disabled = !!rec.paused || !!rec.stopping;
    ui.verbose.checked = !!rec.verbose;
    ui.menu.querySelector('[data-act=deleteLast]').disabled = !rec.stepCount;
    const atBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 20;
    ui.log.innerHTML = '';
    for (const l of rec.log.slice(-80)) {
      const li = document.createElement('li');
      li.className = l.kind;
      const span = document.createElement('span');
      span.textContent = l.msg;
      li.append(span);
      ui.log.appendChild(li);
    }
    if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;
    applyPos();
    if (rec.stopping) { ui.stop.disabled = ui.shot.disabled = ui.pause.disabled = true; ui.stop.textContent = 'Đang xuất...'; }
    renderMeta();
  }

  function setState(next) {
    rec = next;
    if (!rec) {
      if (host) host.remove();
      host = ui = null;
      freeze(false);
      return;
    }
    if (!host || !host.isConnected) buildUI();
    render();
  }

  // Báo cho background biết trang vừa tải (để ghi chuyển trang và khôi phục box)
  send({ type: 'hello', url: location.href, title: document.title }).then((r) => { if (r && r.rec) setState(r.rec); });
})();
