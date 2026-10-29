/**
 * 落地页：没有 ?room= 参数时显示，负责「创建房间 / 加入房间」两个入口。
 *
 * 这一层刻意不碰 WebSocket：没进房间就不该占用一条连接，
 * 也不该在用户还没决定去哪的时候先建出一个空房间。
 * 用户点下按钮后走整页跳转（?room=xxx），由 main.js 在新房间上重新装配。
 */

import {
  enterRoom,
  forgetRooms,
  loadName,
  loadRecentRooms,
  parseRoomInput,
  probeRoom,
  probeServer,
  randomRoomId,
  rememberRoom,
  roomUrl,
  slugRoomName,
  timeAgo,
} from './rooms.js';

const $ = (id) => document.getElementById(id);

export function initWelcome({ toast }) {
  const el = {
    landing: $('landing'),
    pill: $('server-pill'),
    pillText: $('server-pill-text'),
    tabCreate: $('tab-create'),
    tabJoin: $('tab-join'),
    createName: $('create-name'),
    createHint: $('create-hint'),
    createBtn: $('create-btn'),
    joinInput: $('join-input'),
    joinHint: $('join-hint'),
    joinBtn: $('join-btn'),
    recent: $('recent'),
    recentList: $('recent-list'),
    recentClear: $('recent-clear'),
  };

  /** 留空房间名时用哪个随机号：只生成一次，避免每次输入都变一个 */
  let fallbackId = randomRoomId();
  let probeTimer = null;
  let probeSeq = 0;

  // ── 标签页 ────────────────────────────────────────────────
  function switchTab(name) {
    for (const btn of [el.tabCreate, el.tabJoin]) {
      const on = btn.dataset.tab === name;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', String(on));
    }
    for (const pane of el.landing.querySelectorAll('[data-pane]')) {
      pane.hidden = pane.dataset.pane !== name;
    }
    const focus = name === 'create' ? el.createName : el.joinInput;
    setTimeout(() => focus?.focus({ preventScroll: true }), 30);
  }

  el.tabCreate.addEventListener('click', () => switchTab('create'));
  el.tabJoin.addEventListener('click', () => switchTab('join'));

  // ── 服务状态 ──────────────────────────────────────────────
  probeServer().then((info) => {
    if (info && info.ok) {
      el.pill.dataset.state = 'online';
      el.pillText.textContent = '服务在线';
      el.pill.title = `bootEpoch ${info.bootEpoch || '-'} · 内存中 ${info.rooms ?? 0} 个房间`;
    } else {
      el.pill.dataset.state = 'offline';
      el.pillText.textContent = '服务未响应';
      el.pill.title = '拿不到 /healthz，可能是服务端还没启动';
    }
  });

  // ── 创建房间 ──────────────────────────────────────────────
  function createRoomId() {
    const raw = el.createName.value.trim();
    if (!raw) return fallbackId;
    return slugRoomName(raw) || fallbackId;
  }

  function setHint(node, text, state = '') {
    node.textContent = text;
    if (state) node.dataset.state = state;
    else node.removeAttribute('data-state');
  }

  async function refreshCreateHint() {
    const raw = el.createName.value.trim();
    const slug = raw ? slugRoomName(raw) : '';
    const id = raw ? slug || fallbackId : fallbackId;

    if (!raw) {
      setHint(el.createHint, `留空会自动生成房间号 ${id}`);
      return;
    }
    if (!slug) {
      setHint(el.createHint, `房间名只能用英文、数字、- 和 _，将使用自动生成的 ${id}`, 'warn');
      return;
    }

    setHint(el.createHint, `房间号：${slug}（查询中…）`);
    const seq = (probeSeq += 1);
    const info = await probeRoom(slug);
    if (seq !== probeSeq) return;

    if (!info) {
      setHint(el.createHint, `房间号：${slug}`);
      return;
    }
    if (info.exists) {
      const people = info.members > 0 ? ` · ${info.members} 人在线` : '';
      const shapes = typeof info.shapes === 'number' ? ` · ${info.shapes} 个图形` : '';
      setHint(el.createHint, `房间 ${slug} 已存在${people}${shapes}，将直接进入已有内容`, 'warn');
      return;
    }
    setHint(el.createHint, `房间号：${slug} · 新房间`, 'ok');
  }

  function debounce(fn, ms = 280) {
    return () => {
      clearTimeout(probeTimer);
      probeTimer = setTimeout(fn, ms);
    };
  }

  el.createName.addEventListener('input', debounce(refreshCreateHint));

  el.createBtn.addEventListener('click', () => {
    const id = createRoomId();
    rememberRoom(id, loadName());
    enterRoom(id);
  });

  // ── 加入房间 ──────────────────────────────────────────────
  async function refreshJoinHint() {
    const raw = el.joinInput.value.trim();

    if (!raw) {
      setHint(el.joinHint, '支持直接粘贴带 ?room= 的完整链接');
      return;
    }

    const parsed = parseRoomInput(raw);
    if (!parsed) {
      setHint(el.joinHint, '没认出房间号：请检查链接是否完整，或直接输入房间号', 'err');
      return;
    }

    const { roomId, fromLink } = parsed;
    setHint(el.joinHint, fromLink ? `已从链接识别房间 ${roomId}（查询中…）` : `房间 ${roomId}（查询中…）`);

    const seq = (probeSeq += 1);
    const info = await probeRoom(roomId);
    if (seq !== probeSeq) return;

    if (!info) {
      setHint(el.joinHint, `房间 ${roomId} · 暂时查不到状态，仍然可以进入`, 'warn');
      return;
    }
    if (!info.exists) {
      setHint(el.joinHint, `房间 ${roomId} 还不存在，进入后会自动创建`, 'warn');
      return;
    }
    const people = info.members > 0 ? `${info.members} 人在线` : '暂无人在线';
    const shapes = typeof info.shapes === 'number' ? ` · ${info.shapes} 个图形` : '';
    setHint(el.joinHint, `房间 ${roomId} · ${people}${shapes}`, 'ok');
  }

  el.joinInput.addEventListener('input', debounce(refreshJoinHint));

  function submitJoin() {
    const raw = el.joinInput.value.trim();
    if (!raw) {
      toast('请输入房间号，或粘贴邀请链接', 'warn');
      el.joinInput.focus();
      return;
    }
    const parsed = parseRoomInput(raw);
    if (!parsed) {
      toast('没认出房间号，请检查链接是否完整', 'err');
      el.joinInput.focus();
      return;
    }
    rememberRoom(parsed.roomId, loadName());
    enterRoom(parsed.roomId);
  }

  el.joinBtn.addEventListener('click', submitJoin);

  // 输入框里回车直接提交
  el.createName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.createBtn.click();
    }
  });
  el.joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitJoin();
    }
  });

  // 粘贴整条链接时自动切到「加入」页签
  el.createName.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (/room=|https?:\/\//i.test(text)) {
      e.preventDefault();
      el.joinInput.value = text;
      switchTab('join');
      refreshJoinHint();
    }
  });

  // ── 最近打开 ──────────────────────────────────────────────
  function renderRecent() {
    const list = loadRecentRooms();
    el.recent.hidden = list.length === 0;
    el.recentList.innerHTML = '';

    for (const item of list) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = roomUrl(item.id);

      const id = document.createElement('span');
      id.className = 'r-id';
      id.textContent = item.id;

      const meta = document.createElement('span');
      meta.className = 'r-meta';
      meta.textContent = timeAgo(item.at);

      const go = document.createElement('span');
      go.className = 'r-go';
      go.textContent = '进入 →';

      btn.append(id, meta, go);
      btn.addEventListener('click', () => {
        rememberRoom(item.id, loadName());
        enterRoom(item.id);
      });
      li.appendChild(btn);
      el.recentList.appendChild(li);
    }
  }

  el.recentClear.addEventListener('click', () => {
    forgetRooms();
    renderRecent();
    toast('已清空最近记录');
  });

  // ── 初始化 ────────────────────────────────────────────────
  renderRecent();
  refreshCreateHint();

  // 页面从 bfcache 恢复时，最近列表可能已经过期
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) renderRecent();
  });

  return { switchTab, renderRecent };
}
