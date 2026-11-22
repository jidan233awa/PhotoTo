(() => {
  'use strict';

  // ================================================================ 工具
  const $ = (s) => document.querySelector(s);
  const ICONS = '/static/icons.svg';
  const icon = (n) => `<svg class="icon"><use href="${ICONS}#${n}"/></svg>`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB`
    : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
  const fmtTime = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const WEEK = '日一二三四五六';
  const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  function dayLabel(ms) {
    const d = new Date(ms), now = new Date();
    const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const t1 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((t0 - t1) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    const s = `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;
    return d.getFullYear() === now.getFullYear() ? s : `${d.getFullYear()}年${s}`;
  }
  const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)$/i;
  const isImage = (f) => (f.type || '').startsWith('image/') || IMG_RE.test(f.name || '');
  const linkify = (text) => esc(text).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

  let adminPin = sessionStorage.getItem('pt.adminPin') || localStorage.getItem('pt.adminPin') || '';

  async function api(url, body) {
    const headers = { 'X-Admin-Pin': encodeURIComponent(adminPin) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const opt = body === undefined ? { cache: 'no-store', headers }
      : { method: 'POST', headers, body: JSON.stringify(body) };
    const r = await fetch(url, opt);
    const j = await r.json().catch(() => ({ ok: false, err: `HTTP ${r.status}` }));
    if (r.status === 401 && j.adminLock) {
      showAdminLock(j.err || '请输入管理员 PIN 码');
    }
    if (!j.ok) throw new Error(j.err || '操作失败');
    return j;
  }

  function toast(msg, type = 'ok', action) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = icon(type === 'ok' ? 'ok' : 'alert') + `<span>${esc(msg)}</span>`;
    const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-act';
      b.textContent = action.label;
      b.onclick = () => { dismiss(); action.fn(); };
      el.appendChild(b);
      el.style.pointerEvents = 'auto';
    }
    $('#toasts').appendChild(el);
    setTimeout(dismiss, action ? 5000 : 2600);
  }

  async function run(fn) {
    try { await fn(); } catch (e) { toast(e.message || String(e), 'err'); }
  }

  // ---------------------------------------------------------------- 对话框（支持单输入或双输入）
  const dlg = $('#dlg'), dlgInput = $('#dlgInput'), dlgInput2 = $('#dlgInput2');
  function dialog({ title, text = '', input = null, input2 = null, placeholder1 = '', placeholder2 = '', ok = '确定', danger = false }) {
    return new Promise((resolve) => {
      $('#dlgTitle').textContent = title;
      $('#dlgText').textContent = text;
      $('#dlgText').classList.toggle('hidden', !text);
      dlgInput.classList.toggle('hidden', input === null);
      dlgInput2.classList.toggle('hidden', input2 === null);
      if (input !== null) { dlgInput.value = input; dlgInput.placeholder = placeholder1; }
      if (input2 !== null) { dlgInput2.value = input2; dlgInput2.placeholder = placeholder2; }
      const okBtn = $('#dlgOk');
      okBtn.textContent = ok;
      okBtn.className = 'btn ' + (danger ? 'btn-danger solid' : 'btn-primary');
      dlg.returnValue = '';
      dlg.addEventListener('close', () => {
        const yes = dlg.returnValue === 'ok';
        if (input === null) resolve(yes);
        else if (input2 === null) resolve(yes ? dlgInput.value : null);
        else resolve(yes ? [dlgInput.value, dlgInput2.value] : null);
      }, { once: true });
      dlg.showModal();
      if (input !== null) { dlgInput.focus(); dlgInput.select(); } else okBtn.focus();
    });
  }
  const onDlgEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); dlg.close('ok'); } };
  dlgInput.addEventListener('keydown', onDlgEnter);
  dlgInput2.addEventListener('keydown', onDlgEnter);

  // ================================================================ 状态
  const state = {
    view: 'lib',       // 'lib' | 'files' | 'texts' | 'trash'
    items: [],
    shown: [],
    texts: [],
    ips: [],
    ipFilter: '',      // '' 表示全部 IP
    pins: {
      user: { enabled: false, pins: [] },
      admin: { enabled: false, pins: [] },
    },
    pinScope: 'user',  // 'user' | 'admin'
    version: null,
    sel: new Set(),
    selectMode: false,
    anchor: null,
    sort: localStorage.getItem('pt.sort') || 'new',
    tile: +localStorage.getItem('pt.tile') || 180,
    q: '',
    known: null,
    vIndex: -1,
    vName: null,
  };
  let tileCache = new Map();

  const gridEl = $('#grid'), contentEl = $('#content'), textPanelEl = $('#textPanel'), textListEl = $('#textList');
  const tbNormal = $('#tbNormal'), tbSelect = $('#tbSelect');

  const qs = (it) => `v=${it.mtime}-${it.size}${state.view === 'trash' ? '&trash=1' : ''}`;
  const thumbUrl = (it) => `/thumb/${encodeURIComponent(it.name)}?${qs(it)}`;
  const photoUrl = (it) => `/photo/${encodeURIComponent(it.name)}?${qs(it)}`;
  const selecting = () => state.selectMode || state.sel.size > 0;

  function releaseTileMap(oldMap, keepMap) {
    for (const [k, el] of oldMap.entries()) {
      if (keepMap && keepMap.has(k)) continue;
      const img = el.querySelector && el.querySelector('img');
      if (img) img.removeAttribute('src');
    }
  }

  // ---------------------------------------------------------------- 侧边栏抽屉（自适应移动端/窄屏）
  const sidebarEl = $('#sidebar'), sideBackdrop = $('#sideBackdrop');
  function toggleSidebar(open) {
    const isOpen = open === undefined ? !sidebarEl.classList.contains('open') : open;
    sidebarEl.classList.toggle('open', isOpen);
    sideBackdrop.classList.toggle('hidden', !isOpen);
  }
  $('#menuBtn').onclick = () => toggleSidebar();
  sideBackdrop.onclick = () => toggleSidebar(false);

  // ---------------------------------------------------------------- 导入保留文件名开关
  const adminKeepName = $('#adminKeepName');
  adminKeepName.checked = localStorage.getItem('pt.adminKeepName') === '1';
  adminKeepName.onchange = () => localStorage.setItem('pt.adminKeepName', adminKeepName.checked ? '1' : '0');

  // ================================================================ 数据加载
  function setLive(ok) {
    const el = $('#live');
    el.classList.toggle('off', !ok);
    el.querySelector('span').textContent = ok ? '服务运行中' : '服务未运行';
  }

  async function loadInfo() {
    try {
      const info = await api('/api/info');
      state.phoneUrls = info.phoneUrls || [];
      $('#urls').innerHTML = state.phoneUrls.map((u) =>
        `<div class="url"><span title="${esc(u)}">${esc(u.replace(/^http:\/\//, '').replace(/\/$/, ''))}</span>` +
        `<button type="button" data-qr="${esc(u)}" title="显示扫码二维码">${icon('qr')}</button>` +
        `<button type="button" data-copy="${esc(u)}" title="复制">${icon('copy')}</button></div>`).join('');
      $('#dirPath').textContent = info.dir;
      $('#dirPath').title = info.dir;
      if (info.pins) syncPinState(info.pins);
    } catch (e) { setLive(false); }
  }

  function updateStats(s) {
    $('#cntLib').textContent = s.count;
    $('#cntFiles').textContent = s.fileCount || 0;
    $('#cntTexts').textContent = s.textCount || 0;
    $('#cntTrash').textContent = s.trashCount;
    $('#statCount').textContent = s.count;
    $('#statFiles').textContent = s.fileCount || 0;
    $('#statTexts').textContent = s.textCount || 0;
    $('#statSize').textContent = fmtSize((s.size || 0) + (s.fileSize || 0));
    state.ips = s.ips || [];
    syncIpMenu();
  }

  async function load({ silent = false, manual = false } = {}) {
    const view = state.view;
    const btn = $('#refreshBtn');
    if (manual && btn) btn.classList.add('spinning');
    let data;
    try {
      const url = view === 'texts' ? '/api/texts'
        : view === 'trash' ? '/api/photos?trash=1'
        : view === 'files' ? '/api/photos?kind=file'
        : '/api/photos?kind=image';
      data = await api(url);
      setLive(true);
    } catch (e) {
      setLive(false);
      if (!silent) toast(e.message, 'err');
      if (manual && btn) btn.classList.remove('spinning');
      return;
    }
    if (manual && btn) setTimeout(() => btn.classList.remove('spinning'), 250);
    if (view !== state.view) return;
    state.version = data.version;
    updateStats(data.stats);

    if (view === 'texts') {
      state.texts = data.items;
      const ids = new Set(data.items.map((i) => i.id));
      const fresh = new Set();
      if (state.known) ids.forEach((id) => { if (!state.known.has(id)) fresh.add(id); });
      state.known = ids;
      renderTexts(fresh);
      if (fresh.size) toast(`收到 ${fresh.size} 条新文字`);
      else if (manual) toast('已刷新，暂无新文字');
      return;
    }

    state.items = data.items;
    const names = new Set(data.items.map((i) => i.name));
    const fresh = new Set();
    if (view === 'lib' || view === 'files') {
      if (state.known) names.forEach((n) => { if (!state.known.has(n)) fresh.add(n); });
      state.known = names;
    }
    state.sel.forEach((n) => { if (!names.has(n)) state.sel.delete(n); });
    render(fresh);
    if (fresh.size) toast(`收到 ${fresh.size} ${view === 'files' ? '个新文件' : '张新照片'}`);
    else if (manual) toast('已刷新，已是最新');
    syncViewerAfterLoad();
  }

  $('#refreshBtn').onclick = () => load({ manual: true });

  // ================================================================ 渲染（照片 & 文件 & 回收站）
  function sortedFiltered() {
    const q = state.q.trim().toLowerCase();
    const ipf = state.ipFilter;
    let list = state.items.filter((i) => {
      if (ipf && (i.ip || '本机') !== ipf) return false;
      if (q && !i.name.toLowerCase().includes(q) && !(i.ip || '').toLowerCase().includes(q)) return false;
      return true;
    });
    switch (state.sort) {
      case 'old': list.sort((a, b) => a.mtime - b.mtime); break;
      case 'name': list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })); break;
      case 'size': list.sort((a, b) => b.size - a.size); break;
      case 'ip': list.sort((a, b) => (a.ip || '').localeCompare(b.ip || '') || (b.mtime - a.mtime)); break;
      default: list.sort((a, b) => b.mtime - a.mtime);
    }
    return list;
  }

  function makeTile(it) {
    const el = document.createElement('div');
    const ext = (it.name.includes('.') ? it.name.split('.').pop() : 'FILE').slice(0, 6);
    const ip = it.ip || '本机';
    el.className = 'tile' + (it.kind === 'file' ? ' file-tile' : '');
    el.dataset.name = it.name;
    el.dataset.ext = ext;
    el.title = `${it.name}\n大小: ${fmtSize(it.size)}\n时间: ${fmtTime(it.mtime)}\n来源 IP: ${ip}`;
    el.innerHTML = `<div class="tile-shade"></div><button class="tile-check" tabindex="-1" title="选择">${icon('check')}</button><span class="tile-size">${fmtSize(it.size)}</span><div class="tile-name">${esc(it.name)}</div>`;
    if (it.kind === 'file') {
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none';
      box.innerHTML = `${icon('file')}<b>${esc(ext)}</b>`;
      el.prepend(box);
    } else {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.draggable = false;
      img.onload = () => img.classList.add('ok');
      img.onerror = () => el.classList.add('broken');
      img.src = thumbUrl(it);
      el.prepend(img);
    }
    return el;
  }

  function makeFileRow(it) {
    const ext = (it.name.includes('.') ? it.name.split('.').pop() : 'FILE').slice(0, 6);
    const ip = it.ip || '本机';
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.name = it.name;
    row.innerHTML = `
      <button class="f-check" title="选择">${icon('check')}</button>
      <div class="f-badge">${esc(ext)}</div>
      <div class="f-info" title="点击打开文件">
        <div class="f-name">${esc(it.name)}</div>
        <div class="f-meta">${fmtSize(it.size)} · ${fmtTime(it.mtime)} · 来自 ${esc(ip)}</div>
      </div>
      <div class="f-acts">
        <button class="btn btn-ghost btn-icon" data-fact="download" title="下载">${icon('download')}</button>
        <button class="btn btn-ghost btn-icon" data-fact="open" title="用默认程序打开">${icon('external')}</button>
        <button class="btn btn-ghost btn-icon" data-fact="reveal" title="在文件夹中显示">${icon('folder')}</button>
        <button class="btn btn-ghost btn-icon" data-fact="rename" title="重命名">${icon('edit')}</button>
        <button class="btn btn-ghost btn-icon btn-danger" data-fact="delete" title="删除">${icon('trash')}</button>
      </div>`;
    return row;
  }

  function render(fresh = new Set()) {
    textPanelEl.classList.add('hidden');
    gridEl.classList.remove('hidden');

    const list = sortedFiltered();
    state.shown = list;
    const groups = [];
    if (state.sort === 'new' || state.sort === 'old') {
      let cur = null;
      for (const it of list) {
        const k = dayKey(it.mtime);
        if (!cur || cur.key !== k) { cur = { key: k, label: dayLabel(it.mtime), items: [] }; groups.push(cur); }
        cur.items.push(it);
      }
    } else if (state.sort === 'ip') {
      let cur = null;
      for (const it of list) {
        const ip = it.ip || '本机';
        if (!cur || cur.key !== ip) { cur = { key: ip, label: `来源 IP: ${ip}`, items: [] }; groups.push(cur); }
        cur.items.push(it);
      }
    } else if (list.length) {
      groups.push({ key: 'all', label: state.sort === 'name' ? '按文件名排序' : '按大小排序', items: list });
    }

    const frag = document.createDocumentFragment();
    const next = new Map();
    const isFileList = state.view === 'files';
    const unit = isFileList ? '个' : state.view === 'trash' ? '项' : '张';

    for (const g of groups) {
      const sec = document.createElement('section');
      sec.className = 'group';
      sec.innerHTML = `<div class="g-head"><button class="g-check" title="选择本组">${icon('check')}</button>` +
        `<h4>${esc(g.label)}</h4><span>${g.items.length} ${unit}</span></div>` +
        `<div class="${isFileList ? 'file-list' : 'g-grid'}"></div>`;
      const wrap = sec.lastElementChild;
      for (const it of g.items) {
        const key = `${state.view}|${it.name}|${it.mtime}|${it.size}|${it.ip || ''}`;
        const el = tileCache.get(key) || (isFileList ? makeFileRow(it) : makeTile(it));
        next.set(key, el);
        if (fresh.has(it.name)) {
          el.classList.add('is-new');
          setTimeout(() => el.classList.remove('is-new'), 6000);
        }
        wrap.appendChild(el);
      }
      frag.appendChild(sec);
    }
    releaseTileMap(tileCache, next);
    tileCache = next;
    gridEl.replaceChildren(frag);

    updateEmptyState(list.length === 0);
    syncSel();
  }

  // ================================================================ 渲染（文字便签：自动折叠 + 编辑 + 拖拽排序）
  function renderTexts(fresh = new Set()) {
    if (tileCache.size) {
      releaseTileMap(tileCache, null);
      tileCache.clear();
      gridEl.replaceChildren();
    }
    gridEl.classList.add('hidden');
    textPanelEl.classList.remove('hidden');
    const q = state.q.trim().toLowerCase();
    const ipf = state.ipFilter;
    const list = state.texts.filter((t) => {
      if (ipf && (t.ip || '本机') !== ipf) return false;
      if (q && !t.text.toLowerCase().includes(q) && !(t.ip || '').toLowerCase().includes(q)) return false;
      return true;
    });

    textListEl.innerHTML = list.map((t) => {
      const isLong = t.text.length > 120 || t.text.split('\n').length > 3;
      return `
      <article class="text-card${fresh.has(t.id) ? ' is-new' : ''}" data-id="${esc(t.id)}" draggable="true" title="点击查看详情，按住可拖拽排序">
        <div class="tc-head">
          <span class="tc-grip" title="按住拖拽调整顺序">${icon('grip')}</span>
          <div class="tc-meta">
            <span>${fmtTime(t.mtime)}</span>
            <span>·</span>
            <span>${t.text.length} 字</span>
            <span>· 来自 ${esc(t.ip || '本机')}</span>
          </div>
          <div class="tc-acts">
            <button class="btn btn-sm" data-tact="copy" type="button">${icon('copy')}复制</button>
            <button class="btn btn-ghost btn-icon" data-tact="edit" type="button" title="编辑文字">${icon('edit')}</button>
            <button class="btn btn-ghost btn-icon" data-tact="download" type="button" title="保存为 .txt">${icon('download')}</button>
            <button class="btn btn-ghost btn-icon btn-danger" data-tact="del" type="button" title="删除">${icon('trash')}</button>
          </div>
        </div>
        <pre class="tc-body">${linkify(t.text)}</pre>
        ${isLong ? `<div class="tc-more"><span>点击展开全文</span><span>→</span></div>` : ''}
      </article>`;
    }).join('');

    updateEmptyState(list.length === 0);
  }

  // 文字详情与编辑弹窗
  const textDlg = $('#textDlg'), tmBody = $('#tmBody'), tmEdit = $('#tmEdit');
  let activeTextItem = null, textEditing = false;

  function setTextEditMode(editing) {
    textEditing = !!editing;
    tmBody.classList.toggle('hidden', textEditing);
    tmEdit.classList.toggle('hidden', !textEditing);
    $('#tmEditBtn').classList.toggle('hidden', textEditing);
    $('#tmDownload').classList.toggle('hidden', textEditing);
    $('#tmCopy').classList.toggle('hidden', textEditing);
    $('#tmCancelEdit').classList.toggle('hidden', !textEditing);
    $('#tmSaveEdit').classList.toggle('hidden', !textEditing);
    if (textEditing && activeTextItem) {
      tmEdit.value = activeTextItem.text;
      setTimeout(() => { tmEdit.focus(); tmEdit.setSelectionRange(tmEdit.value.length, tmEdit.value.length); }, 10);
    }
  }

  function openTextModal(item, startEdit = false) {
    activeTextItem = item;
    $('#tmMeta').textContent = `${fmtTime(item.mtime)} · ${item.text.length} 字 · 来自 ${item.ip || '本机'}`;
    tmBody.innerHTML = linkify(item.text);
    setTextEditMode(startEdit);
    if (!textDlg.open) textDlg.showModal();
  }

  async function saveTextEdit() {
    if (!activeTextItem) return;
    const content = tmEdit.value.trim();
    if (!content) { toast('文字内容不能为空', 'err'); tmEdit.focus(); return; }
    const btn = $('#tmSaveEdit');
    btn.disabled = true;
    try {
      const r = await api('/api/text/update', { id: activeTextItem.id, text: content });
      const upd = r.item;
      const idx = state.texts.findIndex((t) => t.id === activeTextItem.id);
      if (idx >= 0 && upd) state.texts[idx] = upd;
      activeTextItem = upd || { ...activeTextItem, text: content };
      $('#tmMeta').textContent = `${fmtTime(activeTextItem.mtime)} · ${activeTextItem.text.length} 字 · 来自 ${activeTextItem.ip || '本机'}`;
      tmBody.innerHTML = linkify(activeTextItem.text);
      setTextEditMode(false);
      renderTexts();
      toast('已保存修改');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  $('#tmClose').onclick = () => textDlg.close();
  textDlg.addEventListener('click', (e) => { if (e.target === textDlg && !textEditing) textDlg.close(); });
  $('#tmEditBtn').onclick = () => setTextEditMode(true);
  $('#tmCancelEdit').onclick = () => setTextEditMode(false);
  $('#tmSaveEdit').onclick = saveTextEdit;
  tmEdit.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveTextEdit(); }
  });
  $('#tmCopy').onclick = () => { if (activeTextItem) copyText(activeTextItem.text, '已复制文字内容'); };
  $('#tmDownload').onclick = () => { if (activeTextItem) downloadTextItem(activeTextItem); };
  $('#tmDel').onclick = () => {
    if (!activeTextItem) return;
    const id = activeTextItem.id;
    textDlg.close();
    run(async () => {
      await api('/api/text/delete', { ids: [id] });
      toast('已删除该条文字');
      await load({ silent: true });
    });
  };

  function downloadTextItem(item) {
    const blob = new Blob([item.text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `便签_${item.id.split('-')[0]}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function updateEmptyState(empty) {
    $('#emptyState').classList.toggle('hidden', !empty);
    if (!empty) return;
    const hasFilter = !!(state.q.trim() || state.ipFilter);
    $('#emptyReset').classList.toggle('hidden', !hasFilter);
    const iconName = state.view === 'files' ? 'file' : state.view === 'texts' ? 'text' : state.view === 'trash' ? 'trash' : 'images';
    $('#emptyIcon').innerHTML = `<use href="${ICONS}#${iconName}"/>`;
    if (hasFilter) {
      $('#emptyTitle').textContent = '没有匹配的内容';
      $('#emptyText').textContent = '试试清除搜索或筛选条件';
    } else if (state.view === 'files') {
      $('#emptyTitle').textContent = '还没有文件';
      $('#emptyText').textContent = '手机上传，或拖入文件';
    } else if (state.view === 'texts') {
      $('#emptyTitle').textContent = '还没有文字便签';
      $('#emptyText').textContent = '在上方输入或从手机发送，支持编辑与拖拽排序';
    } else if (state.view === 'trash') {
      $('#emptyTitle').textContent = '回收站是空的';
      $('#emptyText').textContent = '删除的内容暂存于此，可随时恢复';
    } else {
      $('#emptyTitle').textContent = '还没有照片';
      $('#emptyText').textContent = '手机扫码上传，或拖入图片';
    }
  }
  $('#emptyReset').onclick = () => {
    state.q = '';
    searchEl.value = '';
    state.ipFilter = '';
    syncIpMenu();
    if (state.view === 'texts') renderTexts(); else render();
  };

  // 文字便签交互（新建 + 点击 + 拖拽排序）
  const adminTextInput = $('#adminTextInput'), adminSendText = $('#adminSendText');
  async function saveAdminText() {
    const content = adminTextInput.value.trim();
    if (!content) { toast('请输入文字内容', 'err'); adminTextInput.focus(); return; }
    adminSendText.disabled = true;
    try {
      const r = await api('/api/text', { text: content });
      if (state.known) state.known.add(r.item.id);
      adminTextInput.value = '';
      toast('已保存文字便签');
      await load({ silent: true });
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      adminSendText.disabled = false;
    }
  }
  adminSendText.onclick = saveAdminText;
  adminTextInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveAdminText(); }
  });

  textListEl.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const card = e.target.closest('.text-card');
    if (!card) return;
    const item = state.texts.find((t) => t.id === card.dataset.id);
    if (!item) return;
    const btn = e.target.closest('[data-tact]');
    if (!btn) {
      openTextModal(item, false);
      return;
    }
    const act = btn.dataset.tact;
    if (act === 'copy') {
      copyText(item.text, '已复制文字内容');
    } else if (act === 'edit') {
      openTextModal(item, true);
    } else if (act === 'download') {
      downloadTextItem(item);
    } else if (act === 'del') {
      run(async () => {
        await api('/api/text/delete', { ids: [item.id] });
        toast('已删除该条文字');
        await load({ silent: true });
      });
    }
  });

  // 文字便签卡片拖拽排序
  let dragCard = null, dragOrderBefore = '';
  textListEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.text-card');
    if (!card) return;
    dragCard = card;
    dragOrderBefore = Array.from(textListEl.querySelectorAll('.text-card')).map((c) => c.dataset.id).join(',');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.dataset.id); } catch (_) { /* ignore */ }
    setTimeout(() => card.classList.add('dragging'), 0);
  });
  textListEl.addEventListener('dragover', (e) => {
    if (!dragCard) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.text-card');
    if (!target || target === dragCard) return;
    const cards = Array.from(textListEl.querySelectorAll('.text-card'));
    const dragIdx = cards.indexOf(dragCard);
    const targetIdx = cards.indexOf(target);
    if (dragIdx < 0 || targetIdx < 0) return;
    if (dragIdx < targetIdx) target.after(dragCard);
    else target.before(dragCard);
  });
  textListEl.addEventListener('drop', (e) => {
    if (dragCard) e.preventDefault();
  });
  textListEl.addEventListener('dragend', () => {
    if (!dragCard) return;
    dragCard.classList.remove('dragging');
    dragCard = null;
    const ids = Array.from(textListEl.querySelectorAll('.text-card')).map((c) => c.dataset.id);
    if (ids.join(',') === dragOrderBefore) return;
    // 按新的局部顺序同步 state.texts 并落盘
    const byId = new Map(state.texts.map((t) => [t.id, t]));
    const pickedSet = new Set(ids);
    let pIdx = 0;
    state.texts = state.texts.map((t) => (pickedSet.has(t.id) ? byId.get(ids[pIdx++]) : t));
    run(async () => {
      await api('/api/text/reorder', { ids });
      toast('已更新便签顺序');
    });
  });

  $('#clearTexts').onclick = () => run(async () => {
    if (!state.texts.length) return toast('文字列表已经是空的');
    const ok = await dialog({ title: '清空全部文字', text: `清空全部 ${state.texts.length} 条文字？无法撤销。`, ok: '清空', danger: true });
    if (!ok) return;
    const r = await api('/api/text/clear', {});
    toast(`已清空 ${r.count} 条文字`);
    await load({ silent: true });
  });

  // ================================================================ 选择
  function syncSel() {
    if (state.view === 'texts') {
      tbNormal.classList.remove('hidden');
      tbSelect.classList.add('hidden');
      contentEl.classList.remove('selecting');
      return;
    }
    for (const el of tileCache.values()) el.classList.toggle('sel', state.sel.has(el.dataset.name));
    gridEl.querySelectorAll('.group').forEach((sec) => {
      const rows = sec.querySelectorAll('[data-name]');
      const on = rows.length > 0 && Array.from(rows).every((t) => state.sel.has(t.dataset.name));
      sec.querySelector('.g-check').classList.toggle('on', on);
    });
    const on = selecting();
    tbNormal.classList.toggle('hidden', on);
    tbSelect.classList.toggle('hidden', !on);
    contentEl.classList.toggle('selecting', on);
    const n = state.sel.size;
    $('#selCount').textContent = `已选 ${n} 项`;
    ['#selDownload', '#selRestore', '#selDelete'].forEach((id) => { $(id).disabled = n === 0; });
    $('#selDelete span').textContent = state.view === 'trash' ? '彻底删除' : '删除';
    const all = state.shown.length > 0 && state.shown.every((i) => state.sel.has(i.name));
    $('#selAll').textContent = all ? '取消全选' : '全选';
  }

  function toggle(name) {
    if (state.sel.has(name)) state.sel.delete(name); else state.sel.add(name);
  }

  function rangeSelect(a, b) {
    const ia = state.shown.findIndex((i) => i.name === a);
    const ib = state.shown.findIndex((i) => i.name === b);
    if (ia < 0 || ib < 0) { toggle(b); return; }
    const [s, e] = ia < ib ? [ia, ib] : [ib, ia];
    for (let i = s; i <= e; i++) state.sel.add(state.shown[i].name);
  }

  function clearSel() {
    state.sel.clear();
    state.selectMode = false;
    state.anchor = null;
    syncSel();
  }

  gridEl.addEventListener('click', (e) => {
    const gc = e.target.closest('.g-check');
    if (gc) {
      const names = Array.from(gc.closest('.group').querySelectorAll('[data-name]')).map((t) => t.dataset.name);
      const all = names.every((n) => state.sel.has(n));
      names.forEach((n) => (all ? state.sel.delete(n) : state.sel.add(n)));
      syncSel();
      return;
    }
    const fact = e.target.closest('[data-fact]');
    if (fact) {
      const name = fact.closest('[data-name]').dataset.name;
      const act = fact.dataset.fact;
      if (act === 'download') download([name]);
      else if (act === 'open' || act === 'reveal') run(() => openFile(name, act));
      else if (act === 'rename') run(() => rename(name));
      else if (act === 'delete') run(() => remove([name]));
      return;
    }
    const node = e.target.closest('[data-name]');
    if (!node) return;
    const name = node.dataset.name;
    if (e.shiftKey && state.anchor) {
      rangeSelect(state.anchor, name);
    } else if (e.target.closest('.tile-check, .f-check') || e.ctrlKey || e.metaKey || selecting()) {
      toggle(name);
      state.anchor = name;
    } else {
      const it = state.shown.find((i) => i.name === name);
      if (it && it.kind === 'file') run(() => openFile(name, 'open'));
      else openViewer(name);
      return;
    }
    syncSel();
  });

  $('#selectMode').onclick = () => { state.selectMode = true; syncSel(); };
  $('#selClear').onclick = clearSel;
  $('#selAll').onclick = () => {
    const all = state.shown.every((i) => state.sel.has(i.name));
    state.shown.forEach((i) => (all ? state.sel.delete(i.name) : state.sel.add(i.name)));
    syncSel();
  };
  $('#selDownload').onclick = () => download([...state.sel]);
  $('#selRestore').onclick = () => run(() => restore([...state.sel]));
  $('#selDelete').onclick = () => run(() => remove([...state.sel]));

  // ================================================================ 操作
  function download(names) {
    if (!names.length) return;
    if (names.length === 1) {
      const it = state.items.find((i) => i.name === names[0]);
      if (!it) return;
      const a = document.createElement('a');
      a.href = photoUrl(it) + '&download=1';
      a.download = it.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    const f = $('#zipForm');
    f.names.value = JSON.stringify(names);
    f.trash.value = state.view === 'trash' ? '1' : '0';
    f.submit();
    toast(`正在打包 ${names.length} 个文件…`);
  }

  async function remove(names) {
    if (!names.length) return;
    if (state.view === 'trash') {
      const ok = await dialog({ title: '彻底删除', text: `永久删除 ${names.length} 项？无法撤销。`, ok: '彻底删除', danger: true });
      if (!ok) return;
      const r = await api('/api/purge', { names });
      toast(`已彻底删除 ${r.count} 项`);
    } else {
      const r = await api('/api/delete', { names });
      toast(`已移到回收站 ${r.count} 项`, 'ok', {
        label: '撤销',
        fn: () => run(async () => { await api('/api/restore', { names: r.names }); await load({ silent: true }); }),
      });
    }
    names.forEach((n) => state.sel.delete(n));
    if (!state.sel.size) state.selectMode = false;
    await load({ silent: true });
  }

  async function restore(names) {
    if (!names.length) return;
    const r = await api('/api/restore', { names });
    toast(`已恢复 ${r.count} 项`);
    names.forEach((n) => state.sel.delete(n));
    if (!state.sel.size) state.selectMode = false;
    await load({ silent: true });
  }

  async function rename(name) {
    const stem = name.includes('.') ? name.replace(/\.[^.]+$/, '') : name;
    const val = await dialog({ title: '重命名', text: '扩展名会自动保留', input: stem, ok: '保存' });
    if (val === null || val.trim() === '' || val.trim() === stem) return;
    const r = await api('/api/rename', { name, newName: val.trim(), trash: state.view === 'trash' });
    if (state.known) { state.known.delete(name); state.known.add(r.name); }
    if (state.sel.delete(name)) state.sel.add(r.name);
    if (state.vName === name) state.vName = r.name;
    toast('已重命名');
    await load({ silent: true });
  }

  async function openFile(name, action) {
    await api('/api/open', { name, action, trash: state.view === 'trash' });
    toast(action === 'reveal' ? '已在资源管理器中定位文件' : '已调用系统默认程序打开');
  }

  // 回收站：清理孤儿缩略图与失效元数据
  $('#cleanOrphans').onclick = () => run(async () => {
    const btn = $('#cleanOrphans');
    btn.disabled = true;
    try {
      const r = await api('/api/clean-orphans', {});
      if (r.count === 0 && r.metaCount === 0) {
        toast('暂无失效缩略图');
      } else {
        const parts = [];
        if (r.count > 0) parts.push(`${r.count} 个孤儿缩略图 (${fmtSize(r.freedBytes)})`);
        if (r.metaCount > 0) parts.push(`${r.metaCount} 条失效元数据`);
        toast(`已清理 ${parts.join('、')}`);
      }
    } finally {
      btn.disabled = false;
    }
  });

  $('#emptyTrash').onclick = () => run(async () => {
    if (!state.items.length) return toast('回收站已经是空的');
    const ok = await dialog({ title: '清空回收站', text: `永久删除回收站内 ${state.items.length} 项？无法撤销。`, ok: '清空', danger: true });
    if (!ok) return;
    const r = await api('/api/empty-trash', {});
    toast(`已清空 ${r.count} 项`);
    await load({ silent: true });
  });

  $('#openDir').onclick = () => run(async () => {
    await api('/api/open', {});
    toast('已在资源管理器中打开保存目录');
  });

  // ================================================================ 管理员侧锁屏与双端多 PIN 码管理
  const adminLockScreen = $('#adminLockScreen'), adminLockInput = $('#adminLockInput'), adminLockHint = $('#adminLockHint');
  const adminLockRemember = $('#adminLockRemember'), adminLockSubmit = $('#adminLockSubmit');
  const pinDlg = $('#pinDlg'), pinListEl = $('#pinList'), pinMasterSwitch = $('#pinMasterSwitch');
  const pinNewCode = $('#pinNewCode'), pinNewLabel = $('#pinNewLabel');

  function isAdminLocked() {
    return !adminLockScreen.classList.contains('hidden');
  }

  function showAdminLock(hintText) {
    if (dlg.open) dlg.close();
    if (textDlg.open) textDlg.close();
    if (qrDlg.open) qrDlg.close();
    if (pinDlg.open) pinDlg.close();
    if (aboutDlg.open) aboutDlg.close();
    if (viewerOpen()) closeViewer();
    if (hintText) adminLockHint.textContent = hintText;
    adminLockInput.value = '';
    adminLockScreen.classList.remove('hidden');
    setTimeout(() => adminLockInput.focus(), 20);
  }

  async function submitAdminUnlock() {
    const code = adminLockInput.value.trim();
    if (!code) {
      toast('请输入管理员 PIN 码', 'err');
      adminLockInput.focus();
      return;
    }
    const remember = adminLockRemember.checked;
    adminLockSubmit.disabled = true;
    try {
      const r = await fetch('/api/admin/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: code, remember }),
      });
      const j = await r.json().catch(() => ({ ok: false, err: `HTTP ${r.status}` }));
      if (!j.ok) throw new Error(j.err || '管理员 PIN 码错误');
      adminPin = code;
      sessionStorage.setItem('pt.adminPin', code);
      if (remember) localStorage.setItem('pt.adminPin', code);
      else localStorage.removeItem('pt.adminPin');
      adminLockScreen.classList.add('hidden');
      toast(j.label ? `已解锁（${j.label}）` : '管理中心已解锁');
      await loadInfo();
      await load();
    } catch (e) {
      toast(e.message || '管理员 PIN 码错误', 'err');
      adminLockInput.focus();
      adminLockInput.select();
    } finally {
      adminLockSubmit.disabled = false;
    }
  }

  async function lockAdminNow() {
    adminPin = '';
    sessionStorage.removeItem('pt.adminPin');
    localStorage.removeItem('pt.adminPin');
    try { await fetch('/api/admin/auth/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
    if (tileCache.size) {
      releaseTileMap(tileCache, null);
      tileCache.clear();
      gridEl.replaceChildren();
    }
    textListEl.innerHTML = '';
    showAdminLock('已锁定，请输入管理员 PIN 解锁');
    toast('已锁定管理中心');
  }

  adminLockSubmit.onclick = submitAdminUnlock;
  adminLockInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAdminUnlock(); }
  });
  $('#lockAdminBtn').onclick = lockAdminNow;
  $('#pmLockNow').onclick = lockAdminNow;

  function syncPinState(cfg) {
    if (!cfg) return;
    if ('user' in cfg && 'admin' in cfg) {
      state.pins = cfg;
    } else {
      state.pins = { user: cfg, admin: state.pins.admin || { enabled: false, pins: [] } };
    }
    const uSec = state.pins.user || { enabled: false, pins: [] };
    const aSec = state.pins.admin || { enabled: false, pins: [] };
    const uActive = (uSec.pins || []).filter((p) => p.enabled).length;
    const aActive = (aSec.pins || []).filter((p) => p.enabled).length;
    const uOn = !!(uSec.enabled && uActive > 0);
    const aOn = !!(aSec.enabled && aActive > 0);

    const uBadge = $('#pinUserBadge'), aBadge = $('#pinAdminBadge');
    uBadge.textContent = uOn ? `已开启 · ${uActive}` : '未开启';
    uBadge.classList.toggle('on', uOn);
    aBadge.textContent = aOn ? `已开启 · ${aActive}` : '未开启';
    aBadge.classList.toggle('on', aOn);

    $('#lockAdminBtn').classList.toggle('hidden', !aOn);
    $('#pmLockNow').classList.toggle('hidden', !(aOn && state.pinScope === 'admin'));

    $('#pmTabUserCnt').textContent = (uSec.pins || []).length;
    $('#pmTabAdminCnt').textContent = (aSec.pins || []).length;
    renderPinManager();
  }

  function switchPinScope(scope) {
    state.pinScope = scope === 'admin' ? 'admin' : 'user';
    renderPinManager();
  }

  function renderPinManager() {
    const scope = state.pinScope;
    const isAdminScope = scope === 'admin';
    const sec = (state.pins && state.pins[scope]) || { enabled: false, pins: [] };
    const pins = sec.pins || [];
    const activeCount = pins.filter((p) => p.enabled).length;
    const isOn = !!(sec.enabled && activeCount > 0);

    document.querySelectorAll('#pinScopeTabs .pm-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.scope === scope);
    });
    $('#pmSwitchTitle').textContent = isAdminScope
      ? '开启后台解锁 PIN'
      : '开启手机上传 PIN';
    $('#pmSwitchDesc').textContent = isAdminScope
      ? '开启后，打开后台需输入 PIN 解锁，可随时锁屏。'
      : '开启后，手机上传或发文字需输入 PIN，支持多设备分配。';
    pinMasterSwitch.checked = isOn;
    pinNewLabel.placeholder = isAdminScope
      ? '备注（如：主管理员）'
      : '备注（如：我的手机 / 同事）';

    const aSec = (state.pins && state.pins.admin) || { enabled: false, pins: [] };
    const aOn = !!(aSec.enabled && (aSec.pins || []).some((p) => p.enabled));
    $('#pmLockNow').classList.toggle('hidden', !(aOn && isAdminScope));
    $('#pmSummary').textContent = `当前列表共 ${pins.length} 个 PIN · 已启用 ${activeCount} 个`;

    if (!pins.length) {
      const roleTxt = isAdminScope ? '管理员' : '用户侧';
      pinListEl.innerHTML = `<div class="pm-empty">暂无${roleTxt} PIN。<br>在上方输入或点「随机」即可添加，支持多个。</div>`;
      return;
    }
    pinListEl.innerHTML = pins.map((p) => {
      const usage = p.useCount > 0
        ? `已验证 ${p.useCount} 次 · 最近 ${p.lastIp || ''} (${fmtTime(p.lastUsed)})`
        : '暂未使用';
      return `
      <div class="pm-item${p.enabled ? '' : ' off'}" data-pid="${esc(p.id)}">
        <div class="pm-left">
          <code class="pm-code" title="点击复制 PIN 码" data-pact="copy">${esc(p.pin)}</code>
          <div class="pm-meta">
            <b>${esc(p.label || '未命名 PIN')}</b>
            <small>${esc(usage)}</small>
          </div>
        </div>
        <div class="pm-acts">
          <input type="checkbox" class="switch" data-pact="toggle" title="${p.enabled ? '已启用（点击停用）' : '已停用（点击启用）'}" ${p.enabled ? 'checked' : ''}>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-pact="copy" title="复制 PIN 码">${icon('copy')}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" data-pact="edit" title="修改 PIN 码与备注">${icon('edit')}</button>
          <button type="button" class="btn btn-ghost btn-icon btn-sm btn-danger" data-pact="del" title="删除此 PIN">${icon('trash')}</button>
        </div>
      </div>`;
    }).join('');
  }

  async function openPinManager(initialScope) {
    if (initialScope === 'user' || initialScope === 'admin') state.pinScope = initialScope;
    renderPinManager();
    if (!pinDlg.open) pinDlg.showModal();
    try {
      const r = await api('/api/pins');
      if (r.pins) syncPinState(r.pins);
    } catch (_) { /* ignore */ }
  }

  $('#openPinMgr').onclick = () => openPinManager();
  document.querySelectorAll('[data-open-pin]').forEach((row) => {
    row.onclick = () => openPinManager(row.dataset.openPin);
  });
  $('#pinScopeTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-scope]');
    if (tab) switchPinScope(tab.dataset.scope);
  });
  $('#pinClose').onclick = () => pinDlg.close();
  pinDlg.addEventListener('click', (e) => { if (e.target === pinDlg) pinDlg.close(); });

  $('#pinRandBtn').onclick = () => {
    pinNewCode.value = String(Math.floor(1000 + Math.random() * 9000));
    pinNewCode.focus();
  };

  async function addNewPin() {
    const scope = state.pinScope;
    const code = pinNewCode.value.trim();
    const label = pinNewLabel.value.trim();
    if (!code) {
      toast('请先输入 PIN 码', 'err');
      pinNewCode.focus();
      return;
    }
    const r = await api('/api/pins/add', { scope, pin: code, label });
    if (r.autoAdminPin) {
      adminPin = r.autoAdminPin;
      sessionStorage.setItem('pt.adminPin', adminPin);
    }
    pinNewCode.value = '';
    pinNewLabel.value = '';
    syncPinState(r.pins);
    toast(`已添加${scope === 'admin' ? '管理员侧' : '用户侧'} PIN 码：${code}`);
  }
  $('#pinAddBtn').onclick = () => run(addNewPin);
  pinNewCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(addNewPin); } });
  pinNewLabel.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(addNewPin); } });

  pinMasterSwitch.onchange = () => run(async () => {
    const scope = state.pinScope;
    const target = pinMasterSwitch.checked;
    const sec = (state.pins && state.pins[scope]) || { enabled: false, pins: [] };
    const activeCount = (sec.pins || []).filter((p) => p.enabled).length;
    if (target && activeCount === 0) {
      pinMasterSwitch.checked = false;
      pinNewCode.focus();
      throw new Error('请先添加并启用至少一个 PIN');
    }
    try {
      const r = await api('/api/pins/toggle', { scope, enabled: target });
      syncPinState(r.pins);
      const role = scope === 'admin' ? '管理员侧锁屏' : '用户侧上传';
      toast(target ? `已开启${role} PIN 码验证` : `已关闭${role} PIN 码验证`);
    } catch (e) {
      pinMasterSwitch.checked = !target;
      throw e;
    }
  });

  $('#pinResetStats').onclick = () => run(async () => {
    const r = await api('/api/pins/reset-stats', { scope: state.pinScope });
    syncPinState(r.pins);
    toast('已重置当前列表的验证计数');
  });

  pinListEl.addEventListener('click', (e) => {
    const row = e.target.closest('[data-pid]');
    if (!row) return;
    const pid = row.dataset.pid;
    const scope = state.pinScope;
    const sec = (state.pins && state.pins[scope]) || { enabled: false, pins: [] };
    const item = (sec.pins || []).find((p) => p.id === pid);
    if (!item) return;
    const actEl = e.target.closest('[data-pact]');
    if (!actEl) return;
    const act = actEl.dataset.pact;
    if (act === 'copy') {
      copyText(item.pin, `已复制 PIN 码：${item.pin}`);
    } else if (act === 'toggle') {
      const enabled = actEl.checked;
      run(async () => {
        const r = await api('/api/pins/update', { scope, id: pid, enabled });
        syncPinState(r.pins);
        toast(enabled ? `已启用「${item.label}」` : `已停用「${item.label}」`);
      });
    } else if (act === 'edit') {
      run(async () => {
        const res = await dialog({
          title: `修改${scope === 'admin' ? '管理员' : '用户侧'} PIN`,
          text: '修改 PIN 码或备注：',
          input: item.pin,
          input2: item.label || '',
          placeholder1: 'PIN 码（1~32 位）',
          placeholder2: '备注名称',
          ok: '保存修改',
        });
        if (!res) return;
        const [newPin, newLabel] = res;
        if (!newPin.trim()) { toast('PIN 码不能为空', 'err'); return; }
        const r = await api('/api/pins/update', {
          scope,
          id: pid,
          pin: newPin.trim(),
          label: newLabel.trim() || item.label,
        });
        if (r.autoAdminPin) {
          adminPin = r.autoAdminPin;
          sessionStorage.setItem('pt.adminPin', adminPin);
        }
        syncPinState(r.pins);
        toast('已更新 PIN 码与备注');
      });
    } else if (act === 'del') {
      run(async () => {
        const r = await api('/api/pins/delete', { scope, id: pid });
        syncPinState(r.pins);
        toast(`已删除 PIN 码「${item.label}」`);
      });
    }
  });

  // 按需生成二维码弹窗（点击时才向后端请求 SVG，关闭弹窗立即清空 DOM 释放内存）
  const qrDlg = $('#qrDlg'), qrBox = $('#qrBox'), qrTabs = $('#qrTabs'), qrUrlText = $('#qrUrlText');
  async function showQrForUrl(url) {
    if (!url) return;
    qrUrlText.textContent = url.replace(/\/$/, '');
    if (state.phoneUrls && state.phoneUrls.length > 1) {
      qrTabs.classList.remove('hidden');
      qrTabs.innerHTML = state.phoneUrls.map((u) => {
        const label = u.replace(/^http:\/\//, '').replace(/\/$/, '');
        return `<button type="button" class="qr-tab${u === url ? ' active' : ''}" data-qurl="${esc(u)}">${esc(label)}</button>`;
      }).join('');
    } else {
      qrTabs.classList.add('hidden');
      qrTabs.innerHTML = '';
    }
    qrBox.innerHTML = '<div class="spin"></div>';
    if (!qrDlg.open) qrDlg.showModal();
    try {
      const r = await fetch(`/api/qr?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('生成二维码失败');
      qrBox.innerHTML = await r.text();
    } catch (e) {
      qrBox.innerHTML = '<span style="color:#ef4444;font-size:12px;">二维码生成失败</span>';
    }
  }
  qrTabs.addEventListener('click', (e) => {
    const t = e.target.closest('[data-qurl]');
    if (t) showQrForUrl(t.dataset.qurl);
  });
  $('#qrClose').onclick = () => qrDlg.close();
  qrDlg.addEventListener('click', (e) => { if (e.target === qrDlg) qrDlg.close(); });
  qrDlg.addEventListener('close', () => {
    qrBox.innerHTML = '';
    qrTabs.innerHTML = '';
  });

  // 关于弹窗
  const aboutDlg = $('#aboutDlg');
  $('#aboutBtn').onclick = () => { if (!aboutDlg.open) aboutDlg.showModal(); };
  $('#aboutClose').onclick = () => aboutDlg.close();
  aboutDlg.addEventListener('click', (e) => { if (e.target === aboutDlg) aboutDlg.close(); });

  $('#urls').addEventListener('click', (e) => {
    const q = e.target.closest('[data-qr]');
    if (q) { showQrForUrl(q.dataset.qr); return; }
    const b = e.target.closest('[data-copy]');
    if (b) copyText(b.dataset.copy, '已复制地址');
  });
  async function copyText(text, msg = '已复制') {
    try { await navigator.clipboard.writeText(text); } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(msg);
  }

  // ================================================================ 视图 / 工具栏
  const VIEW_TITLES = { lib: '全部照片', files: '文件管理', texts: '文字便签', trash: '回收站' };
  function switchView(v) {
    state.view = v;
    document.body.className = `view-${v}`;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $('#viewTitle').textContent = VIEW_TITLES[v] || '全部照片';
    toggleSidebar(false);
    state.sel.clear();
    state.selectMode = false;
    state.known = null;
    state.items = [];
    if (v === 'texts') renderTexts(); else render();
    contentEl.scrollTop = 0;
    load();
  }
  document.querySelectorAll('.nav-item').forEach((b) => { b.onclick = () => switchView(b.dataset.view); });

  // 来源 IP 筛选下拉框
  const ipMenu = $('#ipMenu'), ipBtn = $('#ipBtn'), ipPop = $('#ipPop'), ipLabel = $('#ipLabel');
  function syncIpMenu() {
    ipLabel.textContent = state.ipFilter ? `IP: ${state.ipFilter}` : '全部 IP';
    ipBtn.classList.toggle('filtered', !!state.ipFilter);
    const allCount = state.ips.reduce((s, i) => s + i.count, 0);
    ipPop.innerHTML = [
      `<button type="button" class="dd-item${state.ipFilter === '' ? ' active' : ''}" data-ip=""><span>全部来源 IP</span><em>${allCount}</em>${icon('check')}</button>`,
      ...state.ips.map((x) =>
        `<button type="button" class="dd-item${state.ipFilter === x.ip ? ' active' : ''}" data-ip="${esc(x.ip)}"><span>${esc(x.ip)}</span><em>${x.count}</em>${icon('check')}</button>`
      ),
    ].join('');
  }
  function closeIpMenu() {
    ipMenu.classList.remove('open');
    ipPop.classList.add('hidden');
  }
  ipBtn.onclick = (e) => {
    e.stopPropagation();
    closeSortMenu();
    const open = ipMenu.classList.toggle('open');
    ipPop.classList.toggle('hidden', !open);
  };
  ipPop.addEventListener('click', (e) => {
    const item = e.target.closest('.dd-item');
    if (!item) return;
    state.ipFilter = item.dataset.ip || '';
    syncIpMenu();
    closeIpMenu();
    if (state.view === 'texts') renderTexts(); else render();
  });

  // 自定义排序下拉框
  const sortMenu = $('#sortMenu'), sortBtn = $('#sortBtn'), sortPop = $('#sortPop'), sortLabel = $('#sortLabel');
  const SORT_NAMES = { new: '最新优先', old: '最早优先', ip: '按 IP 分组', name: '按文件名', size: '按大小' };
  function syncSortUI() {
    sortLabel.textContent = SORT_NAMES[state.sort] || '最新优先';
    sortPop.querySelectorAll('.dd-item').forEach((b) => b.classList.toggle('active', b.dataset.val === state.sort));
  }
  function closeSortMenu() {
    sortMenu.classList.remove('open');
    sortPop.classList.add('hidden');
  }
  sortBtn.onclick = (e) => {
    e.stopPropagation();
    closeIpMenu();
    const open = sortMenu.classList.toggle('open');
    sortPop.classList.toggle('hidden', !open);
  };
  sortPop.addEventListener('click', (e) => {
    const item = e.target.closest('.dd-item');
    if (!item) return;
    state.sort = item.dataset.val;
    localStorage.setItem('pt.sort', state.sort);
    syncSortUI();
    closeSortMenu();
    render();
  });
  document.addEventListener('click', (e) => {
    if (!sortMenu.contains(e.target)) closeSortMenu();
    if (!ipMenu.contains(e.target)) closeIpMenu();
  });
  syncSortUI();

  // 深色 / 浅色模式切换（点击处圆形波纹扩散动画）
  const rootEl = document.documentElement;
  const savedTheme = localStorage.getItem('pt.theme');
  if (savedTheme === 'light' || savedTheme === 'dark') rootEl.dataset.theme = savedTheme;
  const currentTheme = () => rootEl.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  $('#themeBtn').addEventListener('click', (e) => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    const apply = () => {
      rootEl.dataset.theme = next;
      localStorage.setItem('pt.theme', next);
    };
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX || (r.left + r.width / 2);
    const y = e.clientY || (r.top + r.height / 2);
    const endRadius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      apply();
      return;
    }
    const vt = document.startViewTransition(apply);
    vt.ready.then(() => {
      rootEl.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
        { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)' }
      );
    });
  });

  const zoomEl = $('#zoom'), searchEl = $('#search');
  zoomEl.value = state.tile;
  const applyTile = () => contentEl.style.setProperty('--tile', state.tile + 'px');
  zoomEl.oninput = () => { state.tile = +zoomEl.value; localStorage.setItem('pt.tile', state.tile); applyTile(); };
  applyTile();
  let searchTimer;
  searchEl.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = searchEl.value;
      if (state.view === 'texts') renderTexts(); else render();
    }, 120);
  };

  // ================================================================ 导入（拖拽 / 按钮）
  const importInput = $('#importInput');
  $('#importBtn').onclick = () => {
    importInput.accept = state.view === 'files' ? '*/*' : 'image/*,*/*';
    importInput.click();
  };
  importInput.onchange = () => { const files = Array.from(importInput.files || []); importInput.value = ''; importFiles(files); };

  async function importFiles(files) {
    if (!files.length) return;
    const box = $('#importer'), txt = $('#importText');
    let done = 0, fail = 0, imgAdded = 0, fileAdded = 0;
    const keepPref = adminKeepName.checked;
    box.classList.remove('hidden');
    txt.textContent = `正在导入 0/${files.length}`;
    const queue = files.slice();
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift();
        const isImg = isImage(f);
        try {
          const headers = { 'X-Filename': encodeURIComponent(f.name), 'Content-Type': f.type || 'application/octet-stream' };
          if (keepPref || !isImg || state.view === 'files') headers['X-Keep-Name'] = '1';
          const r = await fetch('/api/upload', { method: 'POST', headers, body: f });
          const j = await r.json();
          if (!j.ok) throw new Error(j.err);
          if (j.kind === 'file') fileAdded++; else imgAdded++;
          if (state.known) state.known.add(j.name);
        } catch (e) { fail++; }
        txt.textContent = `正在导入 ${++done}/${files.length}`;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    box.classList.add('hidden');
    if (fail) toast(`导入完成，${fail} 项失败`, 'err');
    else toast(`已导入 ${files.length} 项`);
    if (fileAdded && !imgAdded && state.view !== 'files') switchView('files');
    else if (imgAdded && !fileAdded && state.view !== 'lib') switchView('lib');
    else load({ silent: true });
  }

  const dropzone = $('#dropzone');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropzone.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; dropzone.classList.add('hidden'); }
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropzone.classList.add('hidden');
    importFiles(Array.from(e.dataTransfer.files));
  });

  // ================================================================ 大图查看器（含复制图片与 EXIF 浮层）
  const V = { el: $('#viewer'), img: $('#vImg'), stage: $('#vStage'), exif: $('#vExif'), exifBtn: $('#vExifBtn'), exifOpen: false, s: 1, x: 0, y: 0, rot: 0, token: 0 };
  const viewerOpen = () => !V.el.classList.contains('hidden');
  const curItem = () => state.shown[state.vIndex];

  function openViewer(name) {
    const i = state.shown.findIndex((it) => it.name === name);
    if (i < 0) return;
    state.vIndex = i;
    V.el.classList.remove('hidden');
    V.el.focus();
    showCurrent();
  }

  function closeViewer() {
    V.el.classList.add('hidden');
    V.token++;
    V.img.removeAttribute('src');  // 释放大图内存
    V.exifOpen = false;
    V.exif.classList.add('hidden');
    V.exif.innerHTML = '';
    V.exifBtn.classList.remove('active');
    state.vIndex = -1;
    state.vName = null;
  }

  function viewerChrome() {
    const it = curItem();
    if (!it) return;
    $('#vName').textContent = it.name;
    const dim = it._w ? `${it._w} × ${it._h} · ` : '';
    $('#vMeta').textContent = `${state.vIndex + 1} / ${state.shown.length} · ${dim}${fmtSize(it.size)} · ${fmtTime(it.mtime)} · 来自 ${it.ip || '本机'}`;
    V.el.querySelector('.prev').disabled = state.vIndex <= 0;
    V.el.querySelector('.next').disabled = state.vIndex >= state.shown.length - 1;
    const isFile = it.kind === 'file';
    V.el.querySelectorAll('[data-act="rotate-ccw"], [data-act="rotate-cw"], [data-act="copy-img"], [data-act="exif"]').forEach((b) => { b.disabled = isFile; });
  }

  function showCurrent() {
    const it = curItem();
    if (!it) { closeViewer(); return; }
    state.vName = it.name;
    resetZoom();
    viewerChrome();
    if (it.kind === 'file') {
      V.img.classList.add('hidden');
      $('#vFail').classList.remove('hidden');
      V.exif.classList.add('hidden');
      return;
    }
    $('#vFail').classList.add('hidden');
    V.img.classList.remove('hidden');
    V.img.src = thumbUrl(it);  // 先显示已缓存的缩略图，原图加载完再替换
    const token = ++V.token;
    if (V.exifOpen) loadExifForCurrent();
    let full = new Image();
    full.decoding = 'async';
    full.onload = () => {
      if (token !== V.token || !full) return;
      V.img.src = full.src;
      it._w = full.naturalWidth;
      it._h = full.naturalHeight;
      full.onload = full.onerror = null;
      full = null;
      viewerChrome();
    };
    full.onerror = () => {
      if (token !== V.token) return;
      full.onload = full.onerror = null;
      full = null;
      V.img.classList.add('hidden');
      $('#vFail').classList.remove('hidden');
    };
    full.src = photoUrl(it);
  }

  function rotateCurrent(deg) {
    const it = curItem();
    if (!it || it.kind === 'file') return;
    // 纯前端预览旋转，不修改磁盘文件；以图片自身中心旋转，位置与缩放大小完全不变
    V.rot += deg;
    applyZoom(true);
  }

  // 复制当前图片到系统剪贴板（保留当前预览旋转方向，绘制后立即释放离屏 Canvas 内存）
  async function copyCurrentImage() {
    const it = curItem();
    if (!it || it.kind === 'file') return;
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      toast('当前浏览器不支持复制图片', 'err');
      return;
    }
    const img = V.img;
    if (!img.complete || !img.naturalWidth) {
      toast('图片正在加载，请稍候再试', 'err');
      return;
    }
    const btn = $('#vCopyImgBtn');
    btn.disabled = true;
    let canvas = document.createElement('canvas');
    try {
      const deg = ((V.rot % 360) + 360) % 360;
      const swap = deg === 90 || deg === 270;
      const nw = img.naturalWidth, nh = img.naturalHeight;
      canvas.width = swap ? nh : nw;
      canvas.height = swap ? nw : nh;
      const ctx = canvas.getContext('2d');
      ctx.translate(canvas.width / 2, canvas.height / 2);
      if (deg) ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(img, -nw / 2, -nh / 2);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('生成图片数据失败'))), 'image/png');
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(deg ? `已复制图片到剪贴板（含 ${deg}° 旋转）` : '已复制图片到剪贴板');
    } catch (e) {
      toast('复制图片失败：' + (e.message || '权限受限'), 'err');
    } finally {
      canvas.width = canvas.height = 0;
      canvas = null;
      btn.disabled = false;
    }
  }

  // 按需加载并展示照片 EXIF 信息浮层
  function toggleExif() {
    const it = curItem();
    if (!it || it.kind === 'file') return;
    V.exifOpen = !V.exifOpen;
    V.exifBtn.classList.toggle('active', V.exifOpen);
    V.exif.classList.toggle('hidden', !V.exifOpen);
    if (V.exifOpen) loadExifForCurrent();
  }

  async function loadExifForCurrent() {
    const it = curItem();
    if (!it || it.kind === 'file') return;
    if (it._exif) {
      renderExifPanel(it._exif);
      return;
    }
    V.exif.innerHTML = `<div class="ve-head"><b>${icon('info')}照片信息与 EXIF</b><button type="button" class="ve-close" data-act="exif">${icon('x')}</button></div><div class="ve-empty">正在读取头部元数据…</div>`;
    const targetName = it.name;
    try {
      const url = `/api/exif?name=${encodeURIComponent(targetName)}${state.view === 'trash' ? '&trash=1' : ''}`;
      const r = await api(url);
      it._exif = r.exif;
      if (V.exifOpen && curItem() && curItem().name === targetName) {
        renderExifPanel(it._exif);
      }
    } catch (e) {
      if (V.exifOpen && curItem() && curItem().name === targetName) {
        V.exif.innerHTML = `<div class="ve-head"><b>${icon('info')}照片信息与 EXIF</b><button type="button" class="ve-close" data-act="exif">${icon('x')}</button></div><div class="ve-empty">读取失败：${esc(e.message)}</div>`;
      }
    }
  }

  function renderExifPanel(ex) {
    if (!ex) return;
    const mp = (ex.width && ex.height) ? ` (${((ex.width * ex.height) / 1e6).toFixed(1)} MP)` : '';
    const dimStr = (ex.width && ex.height) ? `${ex.width} × ${ex.height}${mp}` : '未知';
    const fmtStr = [ex.format, ex.mode].filter(Boolean).join(' · ') || '未知';
    const baseRows = [
      ['文件名', ex.name],
      ...(ex.origName && ex.origName !== ex.name ? [['原文件名', ex.origName]] : []),
      ['分辨率', dimStr],
      ['格式 / 色彩', fmtStr],
      ['文件大小', fmtSize(ex.size)],
      ['接收时间', fmtTime(ex.mtime)],
      ['来源设备', ex.ip || '本机'],
    ];
    const exifFields = ex.fields || [];
    V.exif.innerHTML = `
      <div class="ve-head">
        <b>${icon('info')}照片信息与 EXIF</b>
        <button type="button" class="ve-close" data-act="exif" title="关闭 (I)">${icon('x')}</button>
      </div>
      <div class="ve-sec">基本属性</div>
      <div class="ve-grid">
        ${baseRows.map(([k, v]) => `<div class="ve-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      </div>
      <div class="ve-sec">相机 EXIF 参数</div>
      ${exifFields.length
        ? `<div class="ve-grid">${exifFields.map((f) => `<div class="ve-row"><span>${esc(f.label)}</span><b>${esc(f.value)}</b></div>`).join('')}</div>`
        : `<div class="ve-empty">无 EXIF 拍摄信息</div>`
      }`;
  }

  function step(d) {
    const n = state.vIndex + d;
    if (n < 0 || n >= state.shown.length) return;
    state.vIndex = n;
    showCurrent();
  }

  function syncViewerAfterLoad() {
    if (!viewerOpen()) return;
    const i = state.shown.findIndex((it) => it.name === state.vName);
    if (i >= 0) { state.vIndex = i; viewerChrome(); return; }
    if (!state.shown.length) { closeViewer(); return; }
    state.vIndex = Math.min(Math.max(state.vIndex, 0), state.shown.length - 1);
    showCurrent();
  }

  // 缩放 / 平移 / 旋转预览
  function applyZoom(smooth) {
    V.img.classList.toggle('smooth', !!smooth);
    V.img.style.transform = `translate(${V.x}px, ${V.y}px) scale(${V.s}) rotate(${V.rot}deg)`;
    const z = $('#vZoom');
    const deg = ((V.rot % 360) + 360) % 360;
    const zoomed = Math.abs(V.s - 1) > 0.005 || Math.hypot(V.x, V.y) > 4;
    if (zoomed || deg !== 0) {
      const parts = [];
      if (zoomed) parts.push(`${Math.round(V.s * 100)}%`);
      if (deg !== 0) parts.push(`${deg}°`);
      parts.push('重置');
      z.textContent = parts.join(' · ');
      z.classList.remove('hidden');
    } else z.classList.add('hidden');
  }
  function resetZoom(smooth, keepRot) {
    V.s = 1; V.x = 0; V.y = 0;
    if (!keepRot) V.rot = 0;
    applyZoom(smooth);
  }
  $('#vZoom').onclick = () => resetZoom(true);
  function zoomAt(ns, cx, cy, smooth) {
    ns = Math.min(16, Math.max(0.2, ns));
    const r = V.stage.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
    V.x = px - (px - V.x) * (ns / V.s);
    V.y = py - (py - V.y) * (ns / V.s);
    V.s = ns;
    applyZoom(smooth);
  }
  function actualSizeScale() {
    const it = curItem();
    if (!it || !it._w) return 2.5;
    const bw = V.img.clientWidth, bh = V.img.clientHeight;
    const shown = Math.min(bw, bh * (it._w / it._h));
    return Math.max(2, it._w / shown);
  }
  V.stage.addEventListener('wheel', (e) => {
    if (e.target.closest('.v-exif')) return;
    e.preventDefault();
    zoomAt(V.s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }, { passive: false });
  V.stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.v-exif, button')) return;
    if (Math.abs(V.s - 1) > 0.01 || Math.hypot(V.x, V.y) > 2) resetZoom(true, true);
    else zoomAt(actualSizeScale(), e.clientX, e.clientY, true);
  });
  let drag = null;
  V.stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, .v-exif')) return;
    e.preventDefault();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: V.x, oy: V.y };
    V.stage.setPointerCapture(e.pointerId);
    V.stage.classList.add('dragging');
  });
  V.stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    V.x = drag.ox + e.clientX - drag.x;
    V.y = drag.oy + e.clientY - drag.y;
    applyZoom(false);
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== undefined && e.pointerId !== drag.id)) return;
    drag = null;
    V.stage.classList.remove('dragging');
  };
  V.stage.addEventListener('pointerup', endDrag);
  V.stage.addEventListener('pointercancel', endDrag);
  V.stage.addEventListener('lostpointercapture', endDrag);

  function viewerAction(act) {
    const it = curItem();
    if (act === 'close') return closeViewer();
    if (act === 'prev') return step(-1);
    if (act === 'next') return step(1);
    if (!it) return;
    if (act === 'download') return download([it.name]);
    if (act === 'rotate-ccw') return rotateCurrent(-90);
    if (act === 'rotate-cw') return rotateCurrent(90);
    if (act === 'copy-img') return copyCurrentImage();
    if (act === 'exif') return toggleExif();
    run(async () => {
      if (act === 'rename') await rename(it.name);
      else if (act === 'delete') await remove([it.name]);
      else if (act === 'restore') await restore([it.name]);
      else if (act === 'open' || act === 'reveal') await openFile(it.name, act);
    });
  }
  V.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) viewerAction(b.dataset.act);
  });

  // ================================================================ 快捷键
  document.addEventListener('keydown', (e) => {
    if (isAdminLocked() || dlg.open || textDlg.open || qrDlg.open || pinDlg.open || aboutDlg.open) return;
    if (e.altKey && e.key.toLowerCase() === 'l') {
      const aSec = (state.pins && state.pins.admin) || { enabled: false, pins: [] };
      if (aSec.enabled && (aSec.pins || []).some((p) => p.enabled)) {
        e.preventDefault();
        lockAdminNow();
        return;
      }
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (viewerOpen()) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        const sel = window.getSelection && String(window.getSelection());
        if (!sel) {
          e.preventDefault();
          copyCurrentImage();
        }
        return;
      }
      switch (e.key) {
        case 'ArrowLeft': step(-1); break;
        case 'ArrowRight': step(1); break;
        case 'Escape': if (Math.abs(V.s - 1) > 0.01 || Math.hypot(V.x, V.y) > 2) resetZoom(true, true); else closeViewer(); break;
        case 'Delete': viewerAction('delete'); break;
        case 'F2': if (state.view !== 'trash') viewerAction('rename'); break;
        case 'r': case 'R':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            viewerAction(e.shiftKey ? 'rotate-ccw' : 'rotate-cw');
            break;
          }
          return;
        case 'i': case 'I':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            viewerAction('exif');
            break;
          }
          return;
        case '+': case '=': zoomAt(V.s * 1.25, innerWidth / 2, innerHeight / 2, true); break;
        case '-': zoomAt(V.s / 1.25, innerWidth / 2, innerHeight / 2, true); break;
        case '0': resetZoom(true); break;
        default: return;
      }
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
    if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
    if (state.view === 'texts') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      state.shown.forEach((i) => state.sel.add(i.name));
      syncSel();
    } else if (e.key === 'Escape' && selecting()) {
      clearSel();
    } else if (e.key === 'Delete' && state.sel.size) {
      run(() => remove([...state.sel]));
    } else if (e.key === 'F2' && state.sel.size === 1 && state.view !== 'trash') {
      e.preventDefault();
      run(() => rename([...state.sel][0]));
    }
  });

  // ================================================================ 启动（先校验管理员侧 PIN 状态）
  document.body.className = 'view-lib';
  async function boot() {
    try {
      const r = await fetch('/api/admin/auth/status', {
        cache: 'no-store',
        headers: { 'X-Admin-Pin': encodeURIComponent(adminPin) },
      });
      const j = await r.json();
      if (j.ok && j.required && !j.authed) {
        showAdminLock('请输入管理员 PIN 码解锁');
        return;
      }
      if (j.ok && j.required && j.authed && adminPin) {
        // 确保 HttpOnly Cookie 与前端保存的 adminPin 同步（支持 <img src="/thumb/..."> 加载）
        await fetch('/api/admin/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: adminPin, remember: !!localStorage.getItem('pt.adminPin') }),
        }).catch(() => {});
      }
    } catch (_) { /* ignore */ }
    loadInfo();
    load();
  }
  boot();
})();
