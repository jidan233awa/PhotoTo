(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const ICONS = '/static/icons.svg';
  const icon = (n) => `<svg class="icon"><use href="${ICONS}#${n}"/></svg>`;
  const CONCURRENCY = 2;
  const MAX_HISTORY = 30; // 最多保留最近 30 条已完成记录，防止 DOM 与内存增长

  const queueEl = $('#queue'), emptyEl = $('#empty'), summaryEl = $('#summary');
  const clearBtn = $('#clearDone'), connEl = $('#conn');
  const overallEl = $('#overall'), overallBar = $('#overallBar'), overallText = $('#overallText');
  const textInput = $('#textInput'), textCount = $('#textCount'), clearTextBtn = $('#clearText'), sendTextBtn = $('#sendText');
  const keepNameEl = $('#keepName'), keepHintEl = $('#keepHint');
  const userPinBtn = $('#userPinBtn'), userPinText = $('#userPinText');
  const userPinDlg = $('#userPinDlg'), userPinInput = $('#userPinInput'), userPinHint = $('#userPinHint');

  const items = [];
  let active = 0, seq = 0, totalDone = 0;
  let currentPin = localStorage.getItem('pt.pin') || '';
  let pinRequired = false, pinAuthed = true, pinLabel = '';
  let pendingRetryText = false;

  const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)$/i;
  const isImageFile = (f) => (f.type || '').startsWith('image/') || IMG_RE.test(f.name || '');

  function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = icon(type === 'ok' ? 'ok' : 'alert') + `<span>${esc(msg)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2600);
  }

  // ---------------------------------------------------------------- 用户侧 PIN 码认证
  function syncPinPill() {
    userPinBtn.classList.toggle('hidden', !pinRequired);
    if (!pinRequired) return;
    userPinBtn.classList.toggle('unauthed', !pinAuthed);
    userPinText.textContent = pinAuthed ? (pinLabel || 'PIN 已验证') : '输入 PIN 码';
  }

  function openPinModal(msg) {
    if (msg) userPinHint.textContent = msg;
    userPinInput.value = currentPin;
    if (!userPinDlg.open) userPinDlg.showModal();
    setTimeout(() => { userPinInput.focus(); userPinInput.select(); }, 20);
  }

  async function checkAuthStatus() {
    try {
      const r = await fetch('/api/auth/status', {
        cache: 'no-store',
        headers: { 'X-Client': 'phone', 'X-Pin': encodeURIComponent(currentPin) },
      });
      const j = await r.json();
      if (!j.ok) return;
      setConn(true);
      pinRequired = !!j.required;
      pinAuthed = !!j.authed;
      pinLabel = j.label || '';
      syncPinPill();
      if (pinRequired && !pinAuthed) {
        openPinModal('已开启 PIN 保护，请输入 PIN 码继续。');
      }
    } catch (e) {
      setConn(false);
    }
  }

  async function submitUserPin() {
    const code = userPinInput.value.trim();
    if (!code) {
      toast('请输入 PIN 码', 'err');
      userPinInput.focus();
      return;
    }
    const btn = $('#userPinSubmit');
    btn.disabled = true;
    try {
      const r = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client': 'phone' },
        body: JSON.stringify({ pin: code }),
      });
      const j = await r.json().catch(() => ({ ok: false, err: `HTTP ${r.status}` }));
      if (!j.ok) throw new Error(j.err || 'PIN 码错误');
      currentPin = code;
      localStorage.setItem('pt.pin', code);
      pinRequired = !!j.required;
      pinAuthed = true;
      pinLabel = j.label || '';
      syncPinPill();
      userPinDlg.close();
      toast(pinLabel ? `验证通过（${pinLabel}）` : 'PIN 码验证通过');
      // 自动恢复因未验证而暂停的任务
      items.forEach((it) => {
        if (it.status === 'err' && it.needPin) {
          it.needPin = false;
          setStatus(it, 'wait', '等待上传');
        }
      });
      pump();
      if (pendingRetryText && textInput.value.trim()) {
        pendingRetryText = false;
        sendText();
      }
    } catch (e) {
      toast(e.message || 'PIN 码错误', 'err');
      userPinInput.focus();
      userPinInput.select();
    } finally {
      btn.disabled = false;
    }
  }

  userPinBtn.addEventListener('click', () => {
    openPinModal(pinAuthed ? '切换其他 PIN 码：' : '请输入有效 PIN 码：');
  });
  $('#userPinCancel').addEventListener('click', () => userPinDlg.close());
  $('#userPinSubmit').addEventListener('click', submitUserPin);
  userPinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitUserPin(); }
  });

  // ---------------------------------------------------------------- 保留原文件名开关
  keepNameEl.checked = localStorage.getItem('pt.keepName') === '1';
  const syncKeepHint = () => {
    keepHintEl.textContent = keepNameEl.checked
      ? '已开启：均保留原文件名'
      : '关闭时，照片按时间自动命名';
  };
  keepNameEl.addEventListener('change', () => {
    localStorage.setItem('pt.keepName', keepNameEl.checked ? '1' : '0');
    syncKeepHint();
  });
  syncKeepHint();

  // ---------------------------------------------------------------- 单一上传入口（自动分类）
  const pickAny = $('#pickAny');
  $('#uploadBtn').addEventListener('click', () => pickAny.click());
  pickAny.addEventListener('change', () => {
    const files = Array.from(pickAny.files || []);
    pickAny.value = '';
    const keepName = keepNameEl.checked;
    files.forEach((f) => addFile(f, keepName));
    pump();
  });

  function releaseItemMemory(it, removeDom = false) {
    // 上传完成且缩略图生成完毕后立即释放大文件 File 引用
    if (it.status === 'ok' && it.thumbDone) {
      it.file = null;
    }
    if (removeDom) {
      it.file = null;
      if (it.thumbBlobUrl) {
        URL.revokeObjectURL(it.thumbBlobUrl);
        it.thumbBlobUrl = null;
      }
      if (it.el) it.el.remove();
    }
  }

  function addFile(file, keepName = false) {
    const isImg = isImageFile(file);
    const it = {
      id: ++seq,
      file,
      size: file.size || 0,
      name: file.name || (isImg ? '照片' : '文件'),
      keepName,
      isImg,
      thumbDone: !isImg,
      thumbBlobUrl: null,
      status: 'wait',
      loaded: 0,
      err: '',
      needPin: false,
    };
    const li = document.createElement('li');
    li.className = 'item wait';
    li.innerHTML = `
      <div class="thumb">${icon(isImg ? 'image' : 'file')}</div>
      <div class="meta">
        <div class="name">${esc(it.name)}</div>
        <div class="sub"><span class="size">${fmtSize(it.size)}</span><span class="msg">等待上传</span></div>
        <div class="bar"><i></i></div>
      </div>
      <button type="button" class="state" tabindex="-1" aria-label="状态"><div class="spin" style="animation-play-state:paused;opacity:.4"></div></button>`;
    li.querySelector('.state').addEventListener('click', () => {
      if (it.status === 'err') {
        if (it.needPin) { openPinModal(); return; }
        if (!it.file) return;
        setStatus(it, 'wait', '等待上传');
        pump();
      }
    });
    it.el = li;
    queueEl.prepend(li);
    items.push(it);
    if (isImg) makeThumb(it);
    refresh();
  }

  // ---------------------------------------------------------------- 发送文字
  function syncTextUI() {
    const len = textInput.value.length;
    textCount.textContent = `${len} 字`;
    clearTextBtn.classList.toggle('hidden', len === 0);
  }
  textInput.addEventListener('input', syncTextUI);
  clearTextBtn.addEventListener('click', () => { textInput.value = ''; syncTextUI(); textInput.focus(); });
  textInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendText(); }
  });
  sendTextBtn.addEventListener('click', sendText);

  async function sendText() {
    const content = textInput.value.trim();
    if (!content) { toast('请先输入文字内容', 'err'); textInput.focus(); return; }
    sendTextBtn.disabled = true;
    try {
      const r = await fetch('/api/text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client': 'phone',
          'X-Pin': encodeURIComponent(currentPin),
        },
        body: JSON.stringify({ text: content }),
      });
      const j = await r.json().catch(() => ({ ok: false, err: `HTTP ${r.status}` }));
      if (r.status === 401) {
        pinRequired = true;
        pinAuthed = false;
        syncPinPill();
        pendingRetryText = true;
        openPinModal(j.err || '请输入 PIN 码后自动发送');
        return;
      }
      if (!j.ok) throw new Error(j.err || '发送失败');
      setConn(true);
      textInput.value = '';
      syncTextUI();
      toast('文字已发送到电脑');

      const preview = content.replace(/\s+/g, ' ').slice(0, 60);
      const li = document.createElement('li');
      li.className = 'item ok';
      li.innerHTML = `
        <div class="thumb">${icon('text')}</div>
        <div class="meta">
          <div class="name">${esc(preview)}</div>
          <div class="sub"><span class="size">${content.length} 字</span><span class="msg">文字已保存</span></div>
        </div>
        <button type="button" class="state" tabindex="-1" aria-label="已完成">${icon('check')}</button>`;
      queueEl.prepend(li);
      items.push({ id: ++seq, file: null, size: 0, thumbDone: true, status: 'ok', loaded: 0, el: li });
      totalDone++;
      pruneHistory();
      refresh();
    } catch (e) {
      toast(e.message || '发送失败', 'err');
      setConn(false);
    } finally {
      sendTextBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- 小缩略图（逐张生成 + ObjectURL + 完成后释放 File 引用）
  const thumbJobs = [];
  let thumbBusy = false;
  function makeThumb(it) { thumbJobs.push(it); runThumbs(); }
  async function runThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    while (thumbJobs.length) {
      const it = thumbJobs.shift();
      if (!it.file) { it.thumbDone = true; continue; }
      let c = document.createElement('canvas');
      try {
        const bmp = await createImageBitmap(it.file);
        const S = 112;
        c.width = c.height = S;
        const r = Math.max(S / bmp.width, S / bmp.height);
        const w = bmp.width * r, h = bmp.height * r;
        c.getContext('2d').drawImage(bmp, (S - w) / 2, (S - h) / 2, w, h);
        bmp.close && bmp.close();
        const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.68));
        if (blob && it.el && it.el.isConnected) {
          it.thumbBlobUrl = URL.createObjectURL(blob);
          const t = it.el.querySelector('.thumb');
          t.style.backgroundImage = `url(${it.thumbBlobUrl})`;
          t.classList.add('loaded');
        }
      } catch (e) {
        /* 浏览器不支持解码，保留占位图标 */
      } finally {
        c.width = c.height = 0;
        c = null;
        it.thumbDone = true;
        releaseItemMemory(it, false);
      }
    }
    thumbBusy = false;
  }

  // ---------------------------------------------------------------- 上传队列与历史清理
  function pruneHistory() {
    const doneItems = items.filter((i) => i.status === 'ok' && !i.batch);
    while (doneItems.length > MAX_HISTORY) {
      const oldest = doneItems.shift();
      releaseItemMemory(oldest, true);
      const idx = items.indexOf(oldest);
      if (idx >= 0) items.splice(idx, 1);
    }
  }

  function setStatus(it, status, msg) {
    if (status === 'ok' && it.status !== 'ok') totalDone++;
    it.status = status;
    it.el.className = `item ${status}`;
    it.el.querySelector('.msg').textContent = msg;
    const st = it.el.querySelector('.state');
    if (status === 'ok') { st.innerHTML = icon('check'); st.setAttribute('aria-label', '已完成'); st.tabIndex = -1; }
    else if (status === 'err') { st.innerHTML = icon('retry'); st.setAttribute('aria-label', '点击重试'); st.tabIndex = 0; }
    else if (status === 'up') { st.innerHTML = '<div class="spin"></div>'; st.setAttribute('aria-label', '上传中'); st.tabIndex = -1; }
    else { st.innerHTML = '<div class="spin" style="animation-play-state:paused;opacity:.4"></div>'; st.setAttribute('aria-label', '等待中'); st.tabIndex = -1; }
    const bar = it.el.querySelector('.bar i');
    if (bar && status !== 'up') bar.style.width = status === 'ok' ? '100%' : '0';
    refresh();
    if (status === 'ok') {
      releaseItemMemory(it, false);
      pruneHistory();
    }
  }

  function pump() {
    if (pinRequired && !pinAuthed) {
      openPinModal();
      return;
    }
    while (active < CONCURRENCY) {
      const next = items.find((i) => i.status === 'wait' && i.file);
      if (!next) break;
      upload(next);
    }
  }

  function upload(it, attempt = 1) {
    active++;
    it.loaded = 0;
    setStatus(it, 'up', '上传中 0%');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Client', 'phone');
    xhr.setRequestHeader('X-Pin', encodeURIComponent(currentPin));
    xhr.setRequestHeader('X-Filename', encodeURIComponent(it.name || 'file.bin'));
    if (it.keepName || !it.isImg) xhr.setRequestHeader('X-Keep-Name', '1');
    xhr.setRequestHeader('Content-Type', (it.file && it.file.type) || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      it.loaded = e.loaded;
      const p = Math.round((e.loaded / e.total) * 100);
      it.el.querySelector('.bar i').style.width = p + '%';
      it.el.querySelector('.msg').textContent = `上传中 ${p}%`;
      refreshOverall();
    };
    const done = (ok, msg, retryable, unauthorized = false) => {
      active--;
      if (ok) {
        it.needPin = false;
        setStatus(it, 'ok', msg);
        setConn(true);
      } else if (unauthorized) {
        it.needPin = true;
        pinRequired = true;
        pinAuthed = false;
        syncPinPill();
        setStatus(it, 'err', '需要验证 PIN 码（点击验证）');
        openPinModal(msg || '请输入 PIN 码后继续上传');
        return;
      } else if (retryable && attempt < 2 && it.file) {
        it.el.querySelector('.msg').textContent = '网络波动，重试中…';
        setTimeout(() => upload(it, attempt + 1), 1500);
        return;
      } else {
        setStatus(it, 'err', msg);
        if (retryable) setConn(false);
      }
      pump();
    };
    xhr.onload = () => {
      let res = {};
      try { res = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
      if (xhr.status === 200 && res.ok) done(true, `已保存 · ${res.name}`);
      else if (xhr.status === 401) done(false, res.err || '需要输入正确的 PIN 码', false, true);
      else done(false, res.err || `失败 (${xhr.status})`, xhr.status >= 500);
    };
    xhr.onerror = () => done(false, '网络错误，点击重试', true);
    xhr.ontimeout = () => done(false, '超时，点击重试', true);
    xhr.send(it.file);
  }

  // ---------------------------------------------------------------- 状态展示
  function refresh() {
    const okInDom = items.filter((i) => i.status === 'ok').length;
    const err = items.filter((i) => i.status === 'err').length;
    summaryEl.textContent = `本次已传 ${totalDone} 项` + (err ? ` · 失败 ${err}` : '');
    emptyEl.classList.toggle('hidden', items.length > 0);
    clearBtn.classList.toggle('hidden', okInDom === 0);
    refreshOverall();
  }

  function refreshOverall() {
    const pending = items.filter((i) => i.status === 'wait' || i.status === 'up');
    if (!pending.length) {
      items.forEach((i) => { i.batch = false; });
      overallEl.classList.add('hidden');
      pruneHistory();
      return;
    }
    pending.forEach((i) => { i.batch = true; });
    const batch = items.filter((i) => i.batch && i.status !== 'err');
    const total = batch.reduce((s, i) => s + i.size, 0) || 1;
    const sent = batch.reduce((s, i) => s + (i.status === 'ok' ? i.size : i.loaded), 0);
    overallEl.classList.remove('hidden');
    overallBar.style.width = Math.round((sent / total) * 100) + '%';
    overallText.textContent = `剩余 ${pending.length} 项`;
  }

  clearBtn.addEventListener('click', () => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].status === 'ok') {
        releaseItemMemory(items[i], true);
        items.splice(i, 1);
      }
    }
    refresh();
  });

  function setConn(ok) {
    connEl.classList.toggle('off', !ok);
    connEl.querySelector('span').textContent = ok ? '已连接电脑' : '连接已断开';
  }

  window.addEventListener('beforeunload', (e) => {
    if (items.some((i) => i.status === 'up' || i.status === 'wait')) { e.preventDefault(); e.returnValue = ''; }
  });

  // 深色 / 浅色模式切换（点击处圆形波纹扩散动画）
  const rootEl = document.documentElement;
  const themeMeta = $('#themeMeta');
  const savedTheme = localStorage.getItem('pt.theme');
  if (savedTheme === 'light' || savedTheme === 'dark') rootEl.dataset.theme = savedTheme;
  const currentTheme = () => rootEl.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const syncThemeMeta = () => { if (themeMeta) themeMeta.content = currentTheme() === 'light' ? '#ffffff' : '#09090b'; };
  syncThemeMeta();
  $('#themeBtn').addEventListener('click', (e) => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    const apply = () => {
      rootEl.dataset.theme = next;
      localStorage.setItem('pt.theme', next);
      syncThemeMeta();
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

  refresh();
  checkAuthStatus();
})();
