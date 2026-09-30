importScripts('preview.js');

// ---------- Trạng thái phiên ghi (lưu trong storage.session để sống sót khi service worker khởi động lại) ----------
let recCache;
async function getRec() {
  if (recCache === undefined) recCache = (await chrome.storage.session.get('rec')).rec || null;
  return recCache;
}
let saveChain = Promise.resolve();
function mutate(fn) {
  const p = saveChain.then(async () => {
    const rec = await getRec();
    if (!rec) return null;
    const out = fn(rec);
    await chrome.storage.session.set({ rec });
    broadcast(rec);
    return out;
  });
  saveChain = p.catch(() => {});
  return p;
}
function broadcast(rec) {
  chrome.tabs.sendMessage(rec.tabId, { type: 'state', rec }, { frameId: 0 }).catch(() => {});
  chrome.action.setBadgeText({ text: rec.paused ? 'II' : 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: rec.paused ? '#6e6e73' : '#e0352b' });
}
const addLog = (msg, kind = 'info', extra = {}) => mutate((r) => {
  const id = (r.logSeq = (r.logSeq || 0) + 1);
  r.log.push({ id, t: Date.now(), msg, kind, ...extra });
  if (r.log.length > 300) r.log.shift();
  return id;
});
const updateLog = (id, msg, extra = {}) => mutate((r) => {
  const e = r.log.find((l) => l.id === id);
  if (e) { e.msg = msg; Object.assign(e, extra); }
});

// Hàng đợi: các lần chụp chạy lần lượt, không chồng lên nhau
let queue = Promise.resolve();
function enqueue(fn) { queue = queue.then(fn).catch((e) => console.error('[w2f]', e)); return queue; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- IndexedDB cho dữ liệu lớn (các bước, component) ----------
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('w2f', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('steps', { keyPath: 'id' });
      r.result.createObjectStore('components', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb(store, mode, fn) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => { db.close(); res(req && 'result' in req ? req.result : undefined); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
const idbPut = (store, v) => idb(store, 'readwrite', (s) => s.put(v));
const idbDel = (store, k) => idb(store, 'readwrite', (s) => s.delete(k));
const idbGetAll = (store) => idb(store, 'readonly', (s) => s.getAll());
const idbClear = async () => { await idb('steps', 'readwrite', (s) => s.clear()); await idb('components', 'readwrite', (s) => s.clear()); };

// ---------- Giao tiếp với trang ----------
async function toTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['serialize.js', 'content.js'] });
    return await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
}
async function cdp(method, params = {}) {
  const rec = await getRec();
  return chrome.debugger.sendCommand({ tabId: rec.tabId }, method, params);
}

// ---------- Debug của Chrome và khoá kích thước khung nhìn ----------
// Thanh "đang gỡ lỗi" làm khung nhìn thấp đi. Ép trang dàn theo kích thước đo trước khi bật debug,
// để chiều cao trang và vị trí phần tử cố định không đổi giữa các bước.
async function lockViewport(size) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: Math.round(size.w), height: Math.round(size.h), deviceScaleFactor: 0, mobile: false });
  await mutate((r) => { r.locked = { w: Math.round(size.w), h: Math.round(size.h) }; });
}

async function attach() {
  const rec = await getRec();
  if (!rec) return;
  try {
    try { await chrome.debugger.attach({ tabId: rec.tabId }, '1.3'); }
    catch (e) { if (!/already attached/i.test(e.message)) throw e; }
    await mutate((r) => { r.debug = true; });
    // Đo phần bị thanh cảnh báo chiếm, rồi khoá lại kích thước gốc
    await sleep(300);
    const after = await toTab(rec.tabId, { type: 'viewport' }).catch(() => null);
    const base = rec.locked || rec.viewport;
    if (after) await mutate((r) => { r.infobar = Math.max(0, Math.round(base.h - after.h)); });
    await lockViewport(base);
    await addLog(`Đã bật debug để quét hover, giữ khung nhìn ${base.w}×${base.h}. Thanh cảnh báo của Chrome sẽ tự tắt khi bấm Dừng.`, 'note');
  } catch (e) {
    await mutate((r) => { r.debug = false; });
    await addLog(`Không bật được debug (${e.message}). Vẫn ghi màn hình nhưng không quét hover.`, 'warn');
  }
}

async function detach(rec) {
  try { await chrome.debugger.sendCommand({ tabId: rec.tabId }, 'Emulation.clearDeviceMetricsOverride'); } catch (e) { /* đã tắt */ }
  try { await chrome.debugger.detach({ tabId: rec.tabId }); } catch (e) { /* đã tắt */ }
}

chrome.debugger.onDetach.addListener(async (src, reason) => {
  const rec = await getRec();
  if (!rec || src.tabId !== rec.tabId || rec.stopping) return;
  await mutate((r) => { r.debug = false; });
  if (reason === 'target_closed') await addLog('Tab đã đóng.', 'warn');
  else await addLog('Debug đã bị tắt: tạm ngừng quét hover, chiều cao trang có thể thay đổi. Bấm "Bật lại" trên box.', 'warn');
});

// Người dùng đổi cỡ cửa sổ trong lúc ghi: đo lại và khoá theo kích thước mới
let resizeTimer = null;
if (chrome.windows && chrome.windows.onBoundsChanged) {
  chrome.windows.onBoundsChanged.addListener(async (win) => {
    const rec = await getRec();
    if (!rec || !rec.debug || rec.stopping) return;
    const tab = await chrome.tabs.get(rec.tabId).catch(() => null);
    if (!tab || tab.windowId !== win.id) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => enqueue(async () => {
      try {
        await cdp('Emulation.clearDeviceMetricsOverride');
        await sleep(200);
        const vp = await toTab(rec.tabId, { type: 'viewport' });
        const cur = await getRec();
        const size = { w: vp.w, h: vp.h + (cur.infobar || 0) };
        if (cur.locked && size.w === cur.locked.w && size.h === cur.locked.h) { await lockViewport(size); return; }
        await lockViewport(size);
        await addLog(`Cửa sổ đổi cỡ: khung nhìn mới ${size.w}×${size.h}`, 'note');
      } catch (e) { /* debug đã tắt */ }
    }), 400);
  });
}

// ---------- Bắt đầu / dừng / điều khiển phiên ----------
chrome.action.onClicked.addListener(async (tab) => {
  const rec = await getRec();
  if (rec && rec.tabId === tab.id) { await mutate((r) => { r.collapsed = !r.collapsed; }); return; }
  if (rec) { await chrome.tabs.update(rec.tabId, { active: true }).catch(() => {}); return; }
  await start(tab);
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-pause') return;
  const rec = await getRec();
  if (rec && !rec.stopping) await setPaused(!rec.paused);
});

function freshState(extra) {
  return Object.assign({
    log: [], logSeq: 0, stepCount: 0, fps: [], current: null, transitions: [], compOwners: {},
    pending: null, stopping: false, paused: false,
  }, extra);
}

async function start(tab) {
  if (!/^(https?|file):/.test(tab.url || '')) return { error: 'Không ghi được trang này' };
  const vp = await toTab(tab.id, { type: 'viewport' });
  await idbClear();
  recCache = freshState({
    tabId: tab.id, startedAt: Date.now(), viewport: vp, startUrl: tab.url, title: tab.title,
    collapsed: false, debug: false, verbose: false,
  });
  await chrome.storage.session.set({ rec: recCache });
  chrome.action.setTitle({ title: 'Đang ghi: bấm để thu gọn/mở box' });
  broadcast(recCache);
  await addLog(`Bắt đầu ghi (${vp.w}×${vp.h})`, 'info');
  await attach();
  enqueue(() => captureStep({ trigger: { type: 'start' }, label: tab.title }));
  return { ok: true };
}

async function setPaused(value) {
  await mutate((r) => { r.paused = value; r.pending = null; });
  if (value) {
    await addLog('Đã tạm dừng: click không được ghi. Bấm Tiếp tục (hoặc Alt+Shift+P) để ghi tiếp.', 'note');
  } else {
    await addLog('Tiếp tục ghi', 'note');
    // Chụp màn hiện tại để các bước sau nối đúng từ chỗ đang đứng (trùng thì tự bỏ qua)
    enqueue(() => captureStep({ trigger: { type: 'resume' }, label: null }));
  }
}

async function deleteLast() {
  await queue;
  const rec = await getRec();
  if (!rec || !rec.fps.length) return;
  const last = rec.fps[rec.fps.length - 1];
  await idbDel('steps', last.id);
  for (const [key, owner] of Object.entries(rec.compOwners || {})) if (owner === last.id) await idbDel('components', key);
  await mutate((r) => {
    r.fps.pop();
    r.transitions = r.transitions.filter((t) => t.from !== last.id && t.to !== last.id);
    for (const [key, owner] of Object.entries(r.compOwners || {})) if (owner === last.id) delete r.compOwners[key];
    r.stepCount = last.index - 1;
    r.current = last.prev && r.fps.some((f) => f.id === last.prev) ? last.prev : (r.fps.length ? r.fps[r.fps.length - 1].id : null);
  });
  const cur = await getRec();
  const at = cur.fps.find((f) => f.id === cur.current);
  await addLog(`Đã xoá bước ${last.index}${at ? `, đang ở bước ${at.index}` : ''}`, 'note');
}

async function restart() {
  await queue;
  const rec = await getRec();
  if (!rec) return;
  await idbClear();
  await mutate((r) => {
    Object.assign(r, freshState({ startedAt: Date.now() }));
  });
  await addLog('Làm lại từ đầu', 'info');
  const tab = await chrome.tabs.get(rec.tabId).catch(() => null);
  enqueue(() => captureStep({ trigger: { type: 'start' }, label: tab && tab.title }));
}

async function cancel() {
  const rec = await getRec();
  if (!rec) return;
  await mutate((r) => { r.stopping = true; });
  await queue;
  await detach(rec);
  await endSession(rec.tabId);
}

async function endSession(tabId) {
  recCache = null;
  await chrome.storage.session.remove('rec');
  await idbClear();
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: 'Bắt đầu ghi (Alt+Shift+R)' });
  chrome.tabs.sendMessage(tabId, { type: 'state', rec: null }, { frameId: 0 }).catch(() => {});
}

// ---------- Xuất file ----------
// Ảnh và SVG giống nhau chỉ lưu một lần trong "assets", các bước tham chiếu bằng "asset:<mã>"
function packAssets(trees) {
  const assets = {};
  const ref = (v) => {
    if (typeof v !== 'string' || v.length < 1500) return v;
    const h = 'a' + hashStr(v);
    assets[h] = v;
    return 'asset:' + h;
  };
  // SVG có viewBox thì bỏ width/height ở thẻ gốc: kích thước lấy từ khung phần tử, nhờ vậy cùng một hình ở cỡ khác vẫn dùng chung
  const bareSvg = (v) => (typeof v === 'string' && /^\s*<svg[^>]*\sviewBox=/i.test(v)
    ? v.replace(/^(\s*<svg\b[^>]*?)\s(?:width|height)="[^"]*"/i, '$1').replace(/^(\s*<svg\b[^>]*?)\s(?:width|height)="[^"]*"/i, '$1') : v);
  const walk = (n) => {
    if (!n) return;
    if (n.src) n.src = ref(n.src);
    if (n.svg) n.svg = ref(bareSvg(n.svg));
    const st = n.style;
    if (st) {
      if (st.bgImageData) st.bgImageData = ref(st.bgImageData);
      if (st.bgLayer) {
        if (st.bgLayer.data) st.bgLayer.data = ref(st.bgLayer.data);
        if (st.bgLayer.svg) st.bgLayer.svg = ref(st.bgLayer.svg);
      }
    }
    (n.children || []).forEach(walk);
  };
  trees.forEach(walk);
  return assets;
}

async function stop() {
  const rec = await getRec();
  if (!rec || rec.stopping) return;
  await mutate((r) => { r.stopping = true; });
  await addLog('Đang dừng và xuất file...', 'info');
  await queue;
  await detach(rec);

  const final = await getRec();
  const steps = (await idbGetAll('steps')).sort((a, b) => a.index - b.index);
  const components = await idbGetAll('components');
  const trees = [];
  for (const s of steps) { trees.push(s.root); if (s.modal) trees.push(...s.modal.layers); }
  for (const c of components) trees.push(c.base, c.hover, c.active);
  const assets = packAssets(trees);
  const out = {
    format: 'web2figma-recording', version: 3,
    title: final.title, url: final.startUrl, viewport: final.locked || final.viewport,
    startedAt: final.startedAt, endedAt: Date.now(),
    log: final.log.map(({ t, msg, kind }) => ({ t, msg, kind })),
    steps: steps.map((s) => Object.assign({}, s, { preview: renderPreview(s) })),
    transitions: final.transitions || [],
    components,
    assets,
  };
  const json = JSON.stringify(out);
  const slug = (final.title || 'recording').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'recording';
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const filename = `${slug}-${stamp}.w2f.json`;
  try {
    const r = await toTab(final.tabId, { type: 'download', json, filename });
    if (!r || r.error) throw new Error('download');
  } catch (e) {
    const b64 = btoa(unescape(encodeURIComponent(json)));
    await chrome.downloads.download({ url: 'data:application/json;base64,' + b64, filename });
  }
  await endSession(final.tabId);
  return { ok: true, filename, steps: steps.length, components: components.length, bytes: json.length };
}

// ---------- Chụp một bước ----------
const KIND_LABEL = {
  'modal-open': 'mở modal', 'modal-close': 'đóng modal', 'menu-open': 'mở menu', 'menu-close': 'đóng menu', screen: 'chuyển màn',
};

async function captureStep({ trigger, label }) {
  const rec = await getRec();
  if (!rec || rec.stopping) return;
  const tabId = rec.tabId;
  await toTab(tabId, { type: 'freeze', on: true });
  try {
    if (rec.debug) {
      // Đưa con trỏ ảo lên box ghi log để ảnh chụp không dính trạng thái hover của nút vừa bấm
      const p = await toTab(tabId, { type: 'parkPoint' });
      if (p) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }).catch(() => {});
    }
    // Chờ hiệu ứng, ảnh, font và bố cục ổn định
    const st = await toTab(tabId, { type: 'stabilize', maxMs: 5000 });
    const snap = await toTab(tabId, { type: 'snapshot' });
    if (!snap || snap.error) throw new Error(snap && snap.error || 'Không chụp được trang');

    // So sánh với các bước đã có để tránh tạo màn trùng lặp
    const hash = fingerprint(snap);
    const before = await getRec();
    const from = before.current;
    const match = before.fps.find((f) => f.hash === hash);
    if (match && match.id === from) {
      await addLog(`Không có thay đổi so với bước ${match.index}, bỏ qua`, 'note');
      return;
    }
    if (match) {
      await mutate((r) => {
        if (from && trigger.type === 'click') addTransition(r, { from, to: match.id, trigger });
        r.current = match.id;
      });
      await addLog(`Giống bước ${match.index}, quay lại bước ${match.index}`, 'note');
      return;
    }

    const index = await mutate((r) => ++r.stepCount);
    const id = 's' + index;
    const layered = trigger.change === 'modal-open' || trigger.change === 'menu-open';
    const name = (layered && label) || snap.heading || label || `Bước ${index}`;
    await addLog(`Bước ${index}: ${name}`, 'step');
    if (st && !st.stable) await addLog(`Bước ${index} có thể chưa hiện đầy đủ (trang vẫn chuyển động sau ${Math.round(st.waited / 1000)} giây). Nếu thấy thiếu, dùng "Xoá bước cuối" rồi chụp tay lại.`, 'warn');

    const cur = await getRec();
    const refMap = cur.debug && snap.candidates.length ? await scanHover(tabId, snap.candidates, id) : {};
    await idbPut('steps', {
      id, index, name, url: snap.url, title: snap.title,
      trigger: Object.assign({}, trigger, { fromStep: from || null }),
      page: snap.page, root: snap.root,
      modal: layered && snap.modal ? Object.assign({ kind: trigger.change === 'menu-open' ? 'menu' : 'modal' }, snap.modal) : null,
      refMap, capturedAt: Date.now(),
    });
    await mutate((r) => {
      r.fps.push({ id, index, hash, prev: from || null });
      if (from && trigger.type === 'click') addTransition(r, { from, to: id, trigger });
      r.current = id;
    });
  } catch (e) {
    await addLog(`Không chụp được bước này: ${e.message}`, 'warn');
  } finally {
    await toTab(tabId, { type: 'freeze', on: false }).catch(() => {});
  }
}

// Bỏ lượt chuyển màn trùng (cùng màn đi, màn đến và cùng nút)
function addTransition(r, t) {
  const dup = r.transitions.some((x) => x.from === t.from && x.to === t.to && x.trigger.text === t.trigger.text);
  if (!dup) r.transitions.push(t);
}

// ---------- So sánh ----------
function hashStr(str) {
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

// Dấu vân tay giao diện: bỏ qua mã tham chiếu và tên layer, làm tròn toạ độ về 1px
function fingerprint(snap) {
  const json = JSON.stringify({ page: snap.page, root: snap.root }, (k, v) => {
    if (k === 'ref' || k === 'name') return undefined;
    // Phần tử chuyển động liên tục: chỉ tính loại phần tử, bỏ vị trí và nội dung
    if (v && typeof v === 'object' && v.moving) return { moving: true, type: v.type };
    return typeof v === 'number' ? Math.round(v) : v;
  });
  return hashStr(json) + ':' + json.length;
}

function same(a, b) {
  const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' ? Math.round(x * 10) / 10 : x));
  return norm(a) === norm(b);
}

// Hai cây trông giống nhau: cùng cấu trúc, chữ, style; kích thước và vị trí tương đối lệch không quá 4px
function sameLook(a, b, pa, pb) {
  if (!a || !b) return a === b;
  if (a.type !== b.type || (a.text || '') !== (b.text || '')) return false;
  const TOL = 4;
  const ax = a.box.x - (pa ? pa.box.x : a.box.x), ay = a.box.y - (pa ? pa.box.y : a.box.y);
  const bx = b.box.x - (pb ? pb.box.x : b.box.x), by = b.box.y - (pb ? pb.box.y : b.box.y);
  if (Math.abs(ax - bx) > TOL || Math.abs(ay - by) > TOL || Math.abs(a.box.w - b.box.w) > TOL || Math.abs(a.box.h - b.box.h) > TOL) return false;
  const clean = (n) => JSON.stringify([n.style, n.font, n.svg ? n.svg.length : 0, n.src ? n.src.length : 0, n.xf],
    (k, v) => (typeof v === 'number' ? Math.round(v) : v));
  if (clean(a) !== clean(b)) return false;
  const ka = a.children || [], kb = b.children || [];
  if (ka.length !== kb.length) return false;
  return ka.every((c, i) => sameLook(c, kb[i], a, b));
}

// ---------- Quét hover / pressed bằng debug ----------
async function scanHover(tabId, cands, stepId) {
  const total = cands.length;
  const logId = await addLog(`Đang quét 0/${total} nút`, 'scan');
  const refMap = {};
  let done = 0, rootId;
  try {
    await cdp('DOM.enable');
    await cdp('CSS.enable');
    rootId = (await cdp('DOM.getDocument', { depth: 0 })).root.nodeId;
  } catch (e) {
    await updateLog(logId, `Đã quét 0/${total} nút`, { kind: 'scan-done' });
    return refMap;
  }
  const existing = await idbGetAll('components');
  for (let i = 0; i < total; i++) {
    const c = cands[i];
    let nodeId = null;
    try {
      nodeId = (await cdp('DOM.querySelector', { nodeId: rootId, selector: `[data-w2f-ref="${c.ref}"]` })).nodeId;
      if (!nodeId) throw new Error('gone');
      await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      const hover = await toTab(tabId, { type: 'serializeRef', ref: c.ref });
      await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover', 'active'] });
      const active = await toTab(tabId, { type: 'serializeRef', ref: c.ref });
      done++;
      const hasHover = hover && !same(c.base, hover);
      const hasActive = active && !same(hover, active) && !same(c.base, active);
      if (hasHover || hasActive) {
        // Dùng lại component đã có nếu cùng phần tử và trông giống nhau (lệch dưới 4px)
        const found = existing.find((x) => x.identity === c.key && sameLook(x.base, c.base));
        if (found) { refMap[c.ref] = found.key; }
        else {
          const n = existing.filter((x) => x.identity === c.key).length;
          const comp = {
            key: n ? `${c.key}#${n + 1}` : c.key, identity: c.key, name: c.label, base: c.base,
            hover: hasHover ? hover : null, active: hasActive ? active : null,
          };
          existing.push(comp);
          await idbPut('components', comp);
          await mutate((r) => { r.compOwners[comp.key] = stepId; });
          refMap[c.ref] = comp.key;
        }
      }
    } catch (e) { /* nút biến mất hoặc lỗi: không tính */ }
    finally {
      if (nodeId) await cdp('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
    }
    if (i % 3 === 2 || i === total - 1) await updateLog(logId, `Đang quét ${i + 1}/${total} nút`);
  }
  await updateLog(logId, `Đã quét ${done}/${total} nút`, { kind: 'scan-done' });
  return refMap;
}

// ---------- Tải ảnh (chạy ở background để tránh bị CORS chặn) ----------
async function fetchImage(url) {
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const type = blob.type || '';
    if (/svg/.test(type) || /\.svg(\?|#|$)/i.test(url) || /^data:image\/svg/i.test(url)) return { svg: await blob.text() };
    if (/^image\/(png|jpe?g|gif)$/.test(type)) return { dataUrl: await blobToDataUrl(blob) };
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    return { dataUrl: await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' })) };
  } catch (e) {
    return { error: String(e) };
  }
}
function blobToDataUrl(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

// ---------- Nhận tin nhắn từ trang ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(reply, (e) => reply({ error: String(e) }));
  return true;
});

async function handle(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (msg.type === 'fetchImage') return fetchImage(msg.url);
  const rec = await getRec();
  if (!rec || rec.tabId !== tabId) return { rec: null };

  switch (msg.type) {
    case 'hello': {
      if (rec.stopping) return { rec };
      const pend = rec.pending && Date.now() - rec.pending.t < 8000 ? rec.pending : null;
      await mutate((r) => { r.pending = null; });
      const title = msg.title || msg.url;
      if (rec.paused) {
        await addLog(`Mở trang ${title} (đang tạm dừng, không chụp)`, 'note');
        return { rec: await getRec() };
      }
      await addLog(pend ? `Click "${pend.desc.text}" → mở trang ${title}` : `Mở trang ${title}`, 'event');
      enqueue(() => captureStep({
        trigger: pend ? Object.assign({ type: 'click', change: 'navigate' }, pend.desc) : { type: 'navigate' },
        label: msg.title,
      }));
      return { rec: await getRec() };
    }
    case 'click':
      if (!rec.paused) await mutate((r) => { r.pending = { t: Date.now(), desc: msg.desc }; });
      return {};
    case 'change': {
      if (rec.paused) return {};
      await mutate((r) => { r.pending = null; });
      const c = msg.change;
      const late = c.late ? ` (phát hiện sau ${c.late} giây)` : '';
      await addLog(`Click "${msg.desc.text}" → ${KIND_LABEL[c.kind] || c.kind}${c.title ? ': ' + c.title : ''}${late}`, 'event');
      enqueue(() => captureStep({ trigger: Object.assign({ type: 'click', change: c.kind }, msg.desc), label: c.title }));
      return {};
    }
    case 'ignored':
      if (rec.verbose) await addLog(`Bỏ qua click "${msg.desc.text}": ${msg.reason}`, 'verbose');
      return {};
    case 'manual':
      if (rec.paused) return {};
      await addLog('Chụp tay', 'event');
      enqueue(() => captureStep({ trigger: { type: 'manual' }, label: null }));
      return {};
    case 'pause': await setPaused(!!msg.value); return {};
    case 'deleteLast': await deleteLast(); return {};
    case 'restart': await restart(); return {};
    case 'cancel': await cancel(); return {};
    case 'verbose':
      await mutate((r) => { r.verbose = !!msg.value; });
      await addLog(msg.value ? 'Bật log chi tiết: ghi cả những click bị bỏ qua và lý do' : 'Tắt log chi tiết', 'note');
      return {};
    case 'collapse':
      await mutate((r) => { r.collapsed = !!msg.value; });
      return {};
    case 'move':
      await mutate((r) => { r.pos = msg.pos; });
      return {};
    case 'reattach':
      await attach();
      return {};
    case 'stop':
      return await stop();
  }
  return {};
}

// Tab đang ghi bị đóng: dừng và xuất file (tải qua chrome.downloads)
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec && rec.tabId === tabId) await stop();
});
