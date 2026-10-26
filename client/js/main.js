/**
 * 应用入口：装配 store / net / board / interactions / presence / ui。
 *
 * 依赖关系是环形的（store 产生 op 要给 net 发，net 收到广播要写 store），
 * 所以这里先声明再接线，避免模块循环 import。
 */

import { Board } from './canvas.js';
import { Net } from './net.js';
import { Presence } from './presence.js';
import { DocStore } from './store.js';
import { Interactions } from './tools.js';
import { UI } from './ui.js';
import { newSessionEpoch, shortId } from '../../shared/ids.js';
import { isValidRoomId } from '../../shared/protocol.js';

const DEFAULT_ROOM = 'demo';

function pickRoom() {
  const params = new URLSearchParams(location.search);
  const raw = (params.get('room') || '').trim();
  if (raw && isValidRoomId(raw)) return raw;
  return DEFAULT_ROOM;
}

/**
 * 身份：
 *   clientId 存 sessionStorage —— 每个标签页独立，避免同浏览器双开时
 *   两个副本共用 id、产生完全相同的戳而导致裁决结果依赖到达顺序。
 *   sessionEpoch / clientSeq 存 localStorage —— 刷新页面后能接着用，
 *   已入队但未确认的 op 不会因为序号重置被服务端误判成重放。
 */
function loadIdentity(roomId) {
  let clientId = sessionStorage.getItem('wb:clientId');
  if (!clientId || !/^[a-z0-9-]{6,40}$/.test(clientId)) {
    clientId = `c-${shortId(10)}`;
    sessionStorage.setItem('wb:clientId', clientId);
  }

  let sessionEpoch = localStorage.getItem(`wb:epoch:${roomId}`);
  if (!sessionEpoch || !/^[a-z0-9-]{4,40}$/.test(sessionEpoch)) {
    sessionEpoch = newSessionEpoch();
    localStorage.setItem(`wb:epoch:${roomId}`, sessionEpoch);
  }

  let name = localStorage.getItem('wb:name');
  if (!name) {
    name = `访客-${clientId.slice(2, 6)}`;
    localStorage.setItem('wb:name', name);
  }

  return { clientId, sessionEpoch, name };
}

const roomId = pickRoom();
const identity = loadIdentity(roomId);

const canvasEl = document.getElementById('board');
const editorWrap = document.getElementById('text-editor-wrap');
const editor = document.getElementById('text-editor');
const presenceLayer = document.getElementById('presence-layer');
const roomInput = document.getElementById('room-input');
roomInput.value = roomId;

let store;
let net;
let board;
let interactions;
let presence;
let ui;

// ── 文档状态 ───────────────────────────────────────────────────
store = new DocStore({
  roomId,
  clientId: identity.clientId,
  sessionEpoch: identity.sessionEpoch,
  onChange: () => {
    board?.render();
    ui?.refresh();
    ui?.updateSelection();
  },
  onOp: (op) => net?.sendOp(op),
  onLog: (level, msg) => ui?.log(level, msg),
});

// ── 画布 ──────────────────────────────────────────────────────
board = new Board(canvasEl, {
  getShapes: () => store.list(),
  getPreview: () => interactions?.preview || new Map(),
  getSelection: () => interactions?.getSelection() || new Set(),
  getDraft: () => interactions?.draft || null,
  getMarquee: () => interactions?.marquee || null,
});

// ── 交互 ──────────────────────────────────────────────────────
interactions = new Interactions({
  canvasEl,
  board,
  store,
  net: null,
  ui: null,
  editorWrap,
  editor,
});

// ── 网络 ──────────────────────────────────────────────────────
net = new Net({
  roomId,
  identity,
  store,
  handlers: {
    onState: (state) => ui?.setState(state),
    onMembers: (list) => {
      presence?.setMembers(list);
      ui?.setMembers(list);
    },
    onPresence: (msg) => presence?.handle(msg),
    onLog: (level, msg) => ui?.log(level, msg),
    onStats: () => ui?.updateStats(),
    onChange: () => {
      board.render();
      ui?.refresh();
      ui?.updateSelection();
    },
    onConflict: () => ui?.toast('离线修改已被他人覆盖，已同步为最新状态', 'warn'),
    onServerError: (msg) => {
      if (msg.code === 'ROOM_FULL') ui?.toast('房间图形数量已达上限', 'err');
      if (msg.code === 'UNKNOWN_SHAPE') ui?.toast('本地图形与服务端不一致，正在重新同步', 'warn');
    },
  },
});

// ── 光标 ──────────────────────────────────────────────────────
presence = new Presence({
  layer: presenceLayer,
  board,
  onSend: (pt) => net.sendPresence(pt),
});

// ── UI ───────────────────────────────────────────────────────
ui = new UI({
  store,
  net,
  interactions,
  board,
  identity,
  onRoomChange: (nextRoom) => {
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

// ── 启动 ──────────────────────────────────────────────────────
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
