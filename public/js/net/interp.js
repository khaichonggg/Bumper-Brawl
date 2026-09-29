// 快照插值缓冲：服务器每秒发 30 个快照，画面每秒 60 帧以上。
// 以前每帧"追"最新的快照（指数平滑）：快照到得不均匀时画面一顿一顿，还总是慢半拍。
// 现在把快照按服务器时间 st 排好，画面固定显示"服务器现在 - 一小段延迟"那一刻，
// 在前后两个快照之间插值；快照断档时短暂外推，传送 / 复活直接跳过去。
// 自己的角色用更小的延迟，操作跟手；事件（撞击火花、音效）在画面走到那一刻时才播放，而且只播一次。

// 这些数值字段会被插值（其他字段取较早的那个快照，不混合）
const LERP_KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'r', 't', 'life'];
// 快照里按 id 对应的实体列表
const LISTS = ['players', 'bodies', 'items', 'hazards', 'traps', 'meteors'];
// 模式数据里会移动的点（皇冠、钥匙、浮台）
const M_POINTS = ['crown', 'key', 'platforms'];
// 模式数据里的倒计时（Boss 离砸下来还有几秒）：按时间插值；后一个快照里没有了（已经砸下来）就当作 0，
// 这样画面上 Boss 砸到地面的那一刻正好是冲击波那个快照
const M_TIMERS = ['bossT'];
const SNAP_DIST = 220; // 两个快照之间移动超过这个距离：传送 / 复活，不插值
const EXTRAP_MAX = 100; // 快照断档时最多往前外推多少毫秒
const MAX_KEEP = 2000; // 只保留最近 2 秒的快照
const WINDOW = 4000; // 估计时钟偏差 / 抖动的时间窗
const MIN_DELAY = 45;
const MAX_DELAY = 250;
const HARD_SYNC = 300; // 渲染时钟偏得太多（切到后台又回来）就直接对齐
const GRAVITY = 1600; // 和服务器 server/constants.js 的 GRAVITY 一致：外推离地高度时按抛物线走
const STALL_MS = 100; // 离上一帧超过这么久才处理到的消息：页面自己卡住了，收到的时间不准

let buf = []; // { st, s, recv, played, idx }
let samples = []; // { recv, off }：off = st - 本地收到的时间
let offset = null; // 服务器时间 ≈ 本地时间 + offset（取最近一段里延迟最小的那个包）
let jitter = 10;
let interval = 1000 / 30;
let delay = 70;
let starveBoost = 0;
let renderT = null;
let lastNow = null;
let pendingEvents = [];
const lateBuf = []; // 算抖动用的临时数组（每个快照都要算一次，重复用）
const stat = { starved: 0, extrapolated: 0, hardSyncs: 0, snaps: 0, stallPackets: 0 };

/** 清空缓冲（离开房间 / 服务器重启） */
export function reset() {
  buf = [];
  samples = [];
  offset = null;
  renderT = null;
  lastNow = null;
  pendingEvents = [];
  starveBoost = 0;
}

// 每个列表建一个 id → 实体 的索引，插值时查找用
function indexOf(s) {
  const idx = {};
  for (const k of LISTS) {
    const list = s[k];
    if (!Array.isArray(list)) continue;
    const m = new Map();
    for (const e of list) if (e && e.id != null) m.set(e.id, e);
    idx[k] = m;
  }
  return idx;
}

/**
 * 收到一个快照。
 * @param {object} s 服务器发来的 state 消息（带 st = 服务器时间毫秒，旧服务器没有）
 * @param {number} now performance.now()
 */
export function push(s, now) {
  const last = buf[buf.length - 1];
  let st = typeof s.st === 'number' ? s.st : null;
  // 服务器重启（时间倒退）：从头开始
  if (st != null && last && st < last.st - 1000) reset();
  const prev = buf[buf.length - 1];
  if (st == null) st = prev ? prev.st + interval : now; // 没有时间戳的快照（服务器更新前的最后一帧）：接在后面
  if (prev && st <= prev.st) st = prev.st + 1;
  if (prev) interval += (Math.min(200, st - prev.st) - interval) * 0.1;

  // 时钟偏差 + 抖动：最近 4 秒里"到得最早"的包代表真实偏差，其他包晚到多少就是抖动。
  // 页面自己卡住时（编译 shader、建场景、切后台），这期间到的消息要等卡完才一起处理，收到的时间全都偏晚：
  // 这些包只用来估计时钟偏差，不算进网络抖动——不然卡一下之后的好几秒里，画面都会多延迟 200ms
  const off = st - now;
  const noisy = lastNow != null && now - lastNow > STALL_MS;
  if (noisy) stat.stallPackets++;
  samples.push({ recv: now, off, noisy });
  while (samples.length && samples[0].recv < now - WINDOW) samples.shift();
  let best = -Infinity;
  for (const x of samples) best = Math.max(best, x.off);
  offset = best;
  lateBuf.length = 0;
  for (const x of samples) if (!x.noisy) lateBuf.push(best - x.off);
  if (lateBuf.length) {
    lateBuf.sort((a, b) => a - b);
    jitter = lateBuf[Math.floor(lateBuf.length * 0.95)];
  }

  const entry = { st, s, recv: now, played: false, idx: indexOf(s) };
  // 阶段变了（大厅 → 倒计时 → 比赛 → 结算）：立刻显示新阶段，旧快照里没播的事件马上播
  if (prev && prev.s.phase !== s.phase) {
    for (const b of buf) if (!b.played) pendingEvents.push(...(b.s.events || []));
    buf = [];
  }
  buf.push(entry);
  while (buf.length > 2 && buf[0].st < st - MAX_KEEP) {
    // 太旧的快照（页面在后台时攒下的）：事件已经过时，不再播放
    buf.shift();
  }
}

// 目标延迟：1.5 个快照间隔 + 抖动，断档过就再加一点
const targetDelay = () => Math.max(MIN_DELAY, Math.min(MAX_DELAY, interval * 1.5 + jitter + starveBoost));
// 自己的角色：只留出抖动的余量，偶尔不够就外推
const localDelay = () => Math.max(12, Math.min(60, jitter + 10));

const lerp = (a, b, f) => a + (b - a) * f;

function lerpEntity(a, b, f) {
  const o = { ...a };
  if (!b) return o;
  // 复活、传送：不插值
  if (a.alive !== b.alive || (typeof a.x === 'number' && Math.hypot(b.x - a.x, (b.y || 0) - (a.y || 0)) > SNAP_DIST)) {
    stat.snaps++;
    return o;
  }
  for (const k of LERP_KEYS) {
    if (typeof a[k] === 'number' && typeof b[k] === 'number') o[k] = lerp(a[k], b[k], f);
  }
  return o;
}

function extrapolate(a, ms) {
  const o = { ...a };
  const k = ms / 1000;
  if (typeof a.vx === 'number') o.x = a.x + a.vx * k;
  if (typeof a.vy === 'number') o.y = a.y + a.vy * k;
  // 在空中：按抛物线外推（直线外推在最高点附近会一直往上飘）；站在地上的不动
  if (typeof a.vz === 'number' && typeof a.z === 'number' && (a.z > 0 || a.vz > 0)) o.z = Math.max(0, a.z + a.vz * k - 0.5 * GRAVITY * k * k);
  return o;
}

// 找到 t 时刻前后的两个快照
function bracket(t) {
  let i = buf.length - 1;
  while (i > 0 && buf[i].st > t) i--;
  const A = buf[i];
  const B = buf[i + 1] || null;
  return { A, B, f: B ? Math.max(0, Math.min(1, (t - A.st) / (B.st - A.st))) : 0 };
}

function entityAt(list, id, t) {
  const { A, B, f } = bracket(t);
  const a = A.idx[list] && A.idx[list].get(id);
  if (!a) return null;
  if (B) return lerpEntity(a, B.idx[list] && B.idx[list].get(id), f);
  const ahead = t - A.st;
  return ahead > 0 ? extrapolate(a, Math.min(EXTRAP_MAX, ahead)) : { ...a };
}

/**
 * 每帧调用：得到这一帧要显示的状态和该播放的事件。
 * @param {number} now performance.now()
 * @param {number} myId 自己的玩家 id（用更小的延迟显示）
 * @returns {{ state: object, events: object[] } | null}
 */
export function sample(now, myId) {
  if (!buf.length) {
    if (!pendingEvents.length) return null;
    const events = pendingEvents;
    pendingEvents = [];
    return { state: null, events };
  }
  const dt = lastNow == null ? 0 : Math.min(250, Math.max(0, now - lastNow));
  lastNow = now;
  // 延迟：变大可以马上变（渲染时钟放慢追上），变小要慢慢来
  const want = targetDelay();
  delay = want > delay ? want : delay + (want - delay) * Math.min(1, dt / 2000);
  starveBoost = Math.max(0, starveBoost - dt * 0.002);
  const ideal = now + offset - delay;
  if (renderT == null || Math.abs(ideal - renderT) > HARD_SYNC) {
    if (renderT != null) stat.hardSyncs++;
    renderT = ideal;
    // 对齐之后，已经过去的快照里的事件太旧了：不播
    for (const b of buf) if (b.st <= renderT - 500) b.played = true;
  } else {
    // 渲染时钟只会往前走，最多比真实时间快 / 慢 8%，平滑地追上目标（画面不会倒退或跳）
    const next = renderT + dt;
    renderT = next + Math.max(-dt * 0.08, Math.min(dt * 0.08, ideal - next));
  }

  const latest = buf[buf.length - 1];
  if (renderT > latest.st) {
    stat.extrapolated++;
    if (renderT > latest.st + EXTRAP_MAX) {
      // 断档太久：别再往前外推了，等快照；下次多留点延迟
      stat.starved++;
      starveBoost = Math.min(80, starveBoost + 2);
    }
  }

  const { A, B, f } = bracket(renderT);
  const state = { ...A.s };
  for (const k of LISTS) {
    const list = A.s[k];
    if (!Array.isArray(list)) continue;
    if (B) state[k] = list.map((e) => (e && e.id != null ? lerpEntity(e, B.idx[k] && B.idx[k].get(e.id), f) : e));
    else {
      const ahead = Math.min(EXTRAP_MAX, renderT - A.st);
      state[k] = ahead > 0 ? list.map((e) => (e && e.id != null ? extrapolate(e, ahead) : e)) : list;
    }
  }
  if (A.s.m && B && B.s.m) {
    let m = null;
    for (const k of M_POINTS) {
      const a = A.s.m[k];
      const b = B.s.m[k];
      if (Array.isArray(a) && Array.isArray(b)) {
        if (!m) m = { ...A.s.m };
        m[k] = a.map((p, i) => {
          const q = b.find((x) => x.id === p.id) || b[i];
          return q ? { ...p, x: lerp(p.x, q.x, f), y: lerp(p.y, q.y, f) } : p;
        });
        continue;
      }
      if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number' || a.h || b.h) continue;
      if (!m) m = { ...A.s.m };
      m[k] = { ...a, x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) };
    }
    if (m) state.m = m;
  }
  if (A.s.m) {
    for (const k of M_TIMERS) {
      const a = A.s.m[k];
      if (typeof a !== 'number') continue;
      let v = a;
      if (B) {
        const b = B.s.m && typeof B.s.m[k] === 'number' ? B.s.m[k] : 0;
        if (b <= a) v = lerp(a, b, f);
      } else v = Math.max(0, a - Math.max(0, renderT - A.st) / 1000);
      if (state.m === A.s.m) state.m = { ...A.s.m };
      state.m[k] = v;
    }
  }
  // 自己：显示得更"新"一点，操作跟手
  if (myId != null && Array.isArray(state.players)) {
    const tLocal = Math.min(renderT + delay - localDelay(), latest.st + EXTRAP_MAX);
    const i = state.players.findIndex((p) => p.id === myId);
    if (i >= 0 && tLocal > renderT) {
      const mine = entityAt('players', myId, tLocal);
      if (mine) {
        if (state.players === A.s.players) state.players = state.players.slice(); // 别改到原始快照
        state.players[i] = mine;
      }
    }
  }

  // 事件：画面走到这个快照的时刻才播，每个快照只播一次
  let events = pendingEvents;
  pendingEvents = [];
  for (const b of buf) {
    if (b.played || b.st > renderT) continue;
    b.played = true;
    if (b.s.events && b.s.events.length) events = events.length ? events.concat(b.s.events) : b.s.events;
  }
  // 已经播完、渲染时刻也过去了的快照：只留一个当插值起点
  while (buf.length > 2 && buf[1].st <= renderT && buf[0].played) buf.shift();
  return { state, events };
}

/** 调试 / 测量用：当前延迟、抖动、快照间隔等 */
export function info() {
  return { delay: Math.round(delay), jitter: Math.round(jitter), interval: Math.round(interval * 10) / 10, buffered: buf.length, ahead: buf.length && renderT != null ? Math.round(buf[buf.length - 1].st - renderT) : 0, ...stat };
}
