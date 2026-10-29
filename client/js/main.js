/**
 * 应用入口。
 *
 * 两种进入方式：
 *   1. 带 ?room=xxx —— 直接装配白板（分享链接、刷新页面都走这条路）
 *   2. 不带房间号   —— 渲染落地页，让用户「创建房间」或「粘贴链接加入」
 *
 * 之前没有房间号时会静默落到公共的 demo 房间，用户既会看到别人的涂鸦，
 * 也会把自己的画留在那里。现在没有房间号就什么都不连，先把选择权交给用户。
 */

import { Board } from './canvas.js';
import { Net } from './net.js';
import { Presence } from './presence.js';
import { DocStore } from './store.js';
import { Interactions } from './tools.js';
import { UI, toast } from './ui.js';
import { initWelcome } from './welcome.js';
import { loadName, rememberRoom } from './rooms.js';
import { newSessionEpoch, shortId } from '../../shared/ids.js';
import { canonicalRoomId, isValidRoomId } from '../../shared/protocol.js';

/**
 * 从 URL 取房间号。非法值不再回落到任何默认房间——
 * 打错一个字的访客应该被明确告知，而不是被塞进一个陌生人的白板。
 */
function pickRoom() {
  const params = new URLSearchParams(location.search);
  const room = canonicalRoomId(params.get('room') || '');
  return isValidRoomId(room) ? room : '';
}

/**
 * 身份：
 *   clientId 存 sessionStorage —— 每个标签页独立，避免同浏览器双开时
 *   两个副本共用 id、产生完全相同的戳而导致裁决结果依赖到达顺序。
 *   sessionEpoch / clientSeq 存 localStorage —— 刷新页面后能接着用，
 *   已入队但未确认的 op 不会因为序号重置被服务端误判成重放。
 */
/**
 * sessionStorage / localStorage 在「阻止所有站点数据」或部分无痕模式下
 * 会直接抛 SecurityError。身份是进房的前置条件，这里读不到就退化成
 * 「每次加载一个新身份」，绝不能让整个 bootBoard 挂掉变成白屏。
 */
function safeGet(kind, key) {
  try {
    // 注意：连 window.localStorage 这个属性读取本身都可能抛 SecurityError，
    // 所以取属性也必须放在 try 里，不能把 storage 对象当参数传进来。
    return window[kind].getItem(key);
  } catch {
    return null;
  }
}

function safeSet(kind, key, value) {
  try {
    window[kind].setItem(key, value);
  } catch {
    /* 存不下就算了，身份退化为本次会话内存态 */
  }
}

function loadIdentity(roomId) {
  let clientId = safeGet('sessionStorage', 'wb:clientId');
  if (!clientId || !/^[a-z0-9-]{6,40}$/.test(clientId)) {
    clientId = `c-${shortId(10)}`;
    safeSet('sessionStorage', 'wb:clientId', clientId);
  }

  const epochKey = `wb:epoch:${roomId}`;
  let sessionEpoch = safeGet('localStorage', epochKey);
  if (!sessionEpoch || !/^[a-z0-9-]{4,40}$/.test(sessionEpoch)) {
    sessionEpoch = newSessionEpoch();
    safeSet('localStorage', epochKey, sessionEpoch);
  }

  return { clientId, sessionEpoch, name: loadName(clientId) };
}

function bootBoard(roomId) {
  const identity = loadIdentity(roomId);
  rememberRoom(roomId, identity.name);

  document.getElementById('app').hidden = false;

  const canvasEl = document.getElementById('board');
  const editorWrap = document.getElementById('text-editor-wrap');
  const editor = document.getElementById('text-editor');
  const presenceLayer = document.getElementById('presence-layer');

  let store;
  let net;
  let board;
  let interactions;
  let presence;
  let ui;

  /**
   * 首次拿到远端内容时把视野对到图形上——从分享链接进来却看到一张空白画布，
   * 最容易让人以为「没同步」。用户自己先动了手就取消这次自动对焦。
   */
  let autoFitPending = true;
  canvasEl.addEventListener(
    'pointerdown',
    () => {
      autoFitPending = false;
    },
    { once: true },
  );

  /** 首次拿到内容（本地缓存或远端快照）时把视野对到图形上，只做一次 */
  function maybeAutoFit() {
    if (!autoFitPending || !store || !board || !ui) return;
    if (store.stats().visible === 0) return;
    autoFitPending = false;
    board.fitContent();
    ui.updateZoom(board.zoomText);
    presence?.render();
  }

  // ── 文档状态 ─────────────────────────────────────────────────
  store = new DocStore({
    roomId,
    clientId: identity.clientId,
    sessionEpoch: identity.sessionEpoch,
    onChange: () => {
      board?.render();
      ui?.refresh();
      ui?.updateSelection();
      maybeAutoFit();
    },
    onOp: (op) => net?.sendOp(op),
    onLog: (level, msg) => ui?.log(level, msg),
  });

  // ── 画布 ────────────────────────────────────────────────────
  board = new Board(canvasEl, {
    getShapes: () => store.list(),
    getPreview: () => interactions?.preview || new Map(),
    getSelection: () => interactions?.getSelection() || new Set(),
    getDraft: () => interactions?.draft || null,
    getMarquee: () => interactions?.marquee || null,
  });

  // ── 交互 ────────────────────────────────────────────────────
  interactions = new Interactions({
    canvasEl,
    board,
    store,
    net: null,
    ui: null,
    editorWrap,
    editor,
  });

  // ── 网络 ────────────────────────────────────────────────────
  //
  // 成员名单以 welcome 的快照为起点，再用 presence 的 join / leave 增量维护：
  // 只靠 welcome 的话，先到的人永远看不到后来的人（他加入时不会再收到一份快照）。
  const roster = new Map();

  net = new Net({
    roomId,
    identity,
    store,
    handlers: {
      onState: (state) => ui?.setState(state),
      onMembers: (list) => {
        roster.clear();
        for (const m of list) roster.set(m.clientId, m);
        presence?.setMembers(list);
        ui?.setMembers([...roster.values()]);
      },
      onPresence: (msg) => {
        presence?.handle(msg);
        if (msg.event === 'leave') roster.delete(msg.clientId);
        else if (msg.clientId) {
          roster.set(msg.clientId, { clientId: msg.clientId, name: msg.name, color: msg.color });
        }
        ui?.setMembers([...roster.values()]);
      },
      onLog: (level, msg) => ui?.log(level, msg),
      onStats: () => ui?.updateStats(),
      onChange: () => {
        board.render();
        ui?.refresh();
        ui?.updateSelection();
      },
      onConflict: (msg) =>
        ui?.toast(
          msg?.retried
            ? '离线修改已在最新状态上重新应用'
            : '离线修改已被他人覆盖，已同步为最新状态',
          'warn',
        ),
      onServerError: (msg) => {
        if (msg.code === 'ROOM_FULL') ui?.toast('房间图形数量已达上限', 'err');
        if (msg.code === 'UNKNOWN_SHAPE') ui?.toast('本地图形与服务端不一致，正在重新同步', 'warn');
        if (msg.code === 'ROOM_RATE_LIMITED' || msg.code === 'ROOM_LIMIT') {
          ui?.toast(msg.message || '暂时无法创建新房间', 'err');
        }
      },
    },
  });

  // ── 光标 ────────────────────────────────────────────────────
  presence = new Presence({
    layer: presenceLayer,
    board,
    selfId: identity.clientId,
    onSend: (pt) => net.sendPresence(pt),
  });

  // ── UI ─────────────────────────────────────────────────────
  ui = new UI({
    store,
    net,
    interactions,
    board,
    identity,
    onRoomChange: (nextRoom) => {
      // 切换房间要重建 Net / DocStore（两者都在构造时绑定 roomId），
      // 所以走整页跳转——比在运行时热切换状态机可靠得多。
      store.flush();
      const url = new URL(location.href);
      url.searchParams.set('room', nextRoom);
      location.href = url.toString();
    },
  });

  const onViewportChange = () => {
    presence.render();
    ui.updateZoom(board.zoomText);
  };

  interactions.ui = ui;
  interactions.net = net;
  interactions.onCursor = (pt) => presence.sendLocal(pt);
  interactions.onViewportChange = onViewportChange;
  ui.onViewportChange = onViewportChange;

  // ── 启动 ────────────────────────────────────────────────────
  ui.updateZoom(board.zoomText);
  ui.setState('connecting');
  board.render();
  net.connect();

  window.addEventListener('online', () => {
    ui.log('info', '浏览器网络已恢复，尝试立即重连');
    net.retryNow();
  });

  window.addEventListener('offline', () => {
    ui.log('warn', '浏览器网络已断开，进入离线模式');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') net.retryNow();
  });

  // 关闭/刷新前立刻把文档与队列写盘，别让防抖窗口吞掉最后一次编辑
  window.addEventListener('pagehide', () => store.flush());
  window.addEventListener('beforeunload', () => store.flush());

  // 供调试：控制台里可以直接拿到内部对象
  window.__board = { store, net, board, interactions, ui, presence, roomId, identity };
}

// ── 分流 ──────────────────────────────────────────────────────
const roomId = pickRoom();

if (roomId) {
  bootBoard(roomId);
} else {
  document.getElementById('landing').hidden = false;
  initWelcome({ toast });

  // 带着非法 ?room= 进来的人（链接被截断、手抄错），要说清楚为什么没进去
  const raw = new URLSearchParams(location.search).get('room');
  if (raw) {
    setTimeout(() => toast(`房间号「${raw}」不合法，请重新输入或创建新房间`, 'warn'), 300);
  }
}
