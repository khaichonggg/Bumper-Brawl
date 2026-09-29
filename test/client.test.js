// 客户端纯逻辑：快照插值缓冲（net/interp.js）+ 按显卡建议画质（render/gputier.js）
// 两个都是没有依赖的 ES 模块，用 data: URL 导入（不用改 package.json 的 type）
const fs = require('fs');
const path = require('path');
const { check, done } = require('./helpers');
const K = require('../server/constants');

const load = (rel) => import('data:text/javascript,' + encodeURIComponent(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')));

// 造一个快照：玩家 1 以 300/秒 沿 x 移动，玩家 2 不动
function snap(st, extra = {}) {
  const x1 = (st / 1000) * 300;
  return {
    t: 'state',
    st,
    phase: 'playing',
    players: [
      { id: 1, x: x1, y: 0, vx: 300, vy: 0, alive: true, name: 'a' },
      { id: 2, x: 0, y: 50, vx: 0, vy: 0, alive: true, name: 'b' },
    ],
    bodies: [],
    items: [],
    hazards: [],
    traps: [],
    meteors: [],
    m: {},
    events: [{ type: 'tick', st }],
    ...extra,
  };
}

(async () => {
  const interp = await load('public/js/net/interp.js');

  console.log('插值缓冲');
  {
    interp.reset();
    // 服务器每 33ms 发一个，网络延迟 20ms + 0-15ms 的抖动；画面 60 帧
    const offset = 5000; // 服务器时钟比本地快 5 秒
    let nextSend = 0;
    const xs = [];
    const played = [];
    let maxLag = 0;
    for (let now = 0; now < 3000; now += 1000 / 60) {
      // 到达时间 = 发送时间 + 延迟
      while (nextSend + 20 + ((nextSend * 7) % 15) <= now) {
        interp.push(snap(nextSend + offset), nextSend + 20 + ((nextSend * 7) % 15));
        nextSend += 1000 / 30;
      }
      const r = interp.sample(now, 99);
      if (!r || !r.state) continue;
      for (const e of r.events) played.push(e.st);
      if (now > 500) {
        const p = r.state.players.find((q) => q.id === 1);
        xs.push(p.x);
        maxLag = Math.max(maxLag, now + offset - (p.x / 300) * 1000); // 画面显示的是服务器多少毫秒之前的位置
      }
    }
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    const minStep = Math.min(...steps);
    const maxStep = Math.max(...steps);
    check(minStep > 3 && maxStep < 7.5, `匀速移动的角色每帧前进的距离很均匀（${minStep.toFixed(2)} - ${maxStep.toFixed(2)}，理想 5）`);
    const info = interp.info();
    check(info.delay >= 45 && info.delay <= 120, `延迟自动调到 1.5 个快照间隔 + 抖动（${info.delay}ms，抖动 ${info.jitter}ms）`);
    check(maxLag > 40 && maxLag < 150, `画面落后服务器不超过 150ms（网络 20-35ms + 插值延迟，最多落后 ${maxLag.toFixed(0)}ms）`);
    const sorted = played.slice().sort((a, b) => a - b);
    check(played.length > 80 && new Set(played).size === played.length && played.every((v, i) => v === sorted[i]), `每个快照的事件只播一次、按顺序（${played.length} 个）`);
  }

  {
    // 自己的角色用更小的延迟
    interp.reset();
    for (let i = 0; i < 10; i++) interp.push(snap(i * 33), i * 33 + 10);
    const r = interp.sample(330, 1);
    const r2 = (interp.reset(), [...Array(10)].forEach((_, i) => interp.push(snap(i * 33), i * 33 + 10)), interp.sample(330, 99));
    const mine = r.state.players.find((p) => p.id === 1).x;
    const other = r2.state.players.find((p) => p.id === 1).x;
    check(mine > other + 5, `自己的角色显示得更"新"（自己 x=${mine.toFixed(0)}，当成别人时 x=${other.toFixed(0)}）`);
  }

  {
    // 传送 / 复活：不插值，直接跳过去
    interp.reset();
    const a = snap(0);
    const b = snap(33);
    b.players[1] = { ...b.players[1], x: 600, y: 600 };
    const c = snap(66);
    c.players[1] = { ...c.players[1], x: 600, y: 600 };
    interp.push(a, 0);
    interp.push(b, 33);
    interp.push(c, 66);
    const seen = [];
    for (let now = 66; now < 200; now += 8) {
      const r = interp.sample(now, 99);
      seen.push(r.state.players.find((p) => p.id === 2).x);
    }
    check(seen.every((x) => x === 0 || x === 600), `传送时直接跳过去，不会从中间滑过去（${[...new Set(seen)].join(' → ')}）`);
  }

  {
    // 阶段切换：马上显示新阶段，旧快照没播的事件立刻播
    interp.reset();
    interp.push(snap(0), 0);
    interp.push(snap(33, { events: [{ type: 'last' }] }), 33);
    interp.sample(40, 99);
    interp.push(snap(66, { phase: 'roundEnd', events: [{ type: 'roundEnd' }] }), 66);
    const r = interp.sample(70, 99);
    const got = [];
    got.push(...r.events.map((e) => e.type));
    for (let now = 80; now < 400; now += 16) got.push(...interp.sample(now, 99).events.map((e) => e.type));
    check(r.state.phase === 'roundEnd', '阶段变了马上显示新阶段');
    check(got.includes('last') && got.filter((t) => t === 'roundEnd').length === 1, `切换前没播的事件也会播，每个只播一次（${got.filter((t) => t !== 'tick').join(', ')}）`);
  }

  {
    // 快照断档：最多外推 100ms，然后停住等
    interp.reset();
    for (let i = 0; i <= 10; i++) interp.push(snap(i * 33), i * 33 + 5);
    let last = null;
    const xs = [];
    for (let now = 340; now < 900; now += 16) {
      last = interp.sample(now, 99).state.players.find((p) => p.id === 1).x;
      xs.push(last);
    }
    const lastSnapX = (330 / 1000) * 300;
    check(last > lastSnapX && last <= lastSnapX + 300 * 0.1 + 0.01, `断档时往前外推一点点再停住（最后一个快照 x=${lastSnapX}，显示 x=${last.toFixed(1)}）`);
    check(xs.slice(1).every((x, i) => x >= xs[i] - 1e-9), '  外推过程中不会倒退');
  }

  {
    // 服务器重启：时间倒退 → 缓冲清空重新开始；旧服务器没有 st 也能用
    interp.reset();
    for (let i = 0; i < 10; i++) interp.push(snap(100000 + i * 33), i * 33);
    interp.sample(400, 99);
    for (let i = 0; i < 10; i++) interp.push(snap(i * 33), 500 + i * 33);
    const r = interp.sample(900, 99);
    check(r && r.state && r.state.players.length === 2, '服务器重启（时间倒退）后自动重新开始');
    interp.reset();
    for (let i = 0; i < 5; i++) {
      const s = snap(0);
      delete s.st;
      interp.push(s, i * 33);
    }
    check(interp.sample(300, 99).state.players.length === 2, '没有时间戳的快照也能显示');
  }

  {
    // 页面自己卡了 400ms（编译 shader、建场景）：卡住期间到的快照在卡完后一起处理，不能当成网络抖动把延迟拉满
    interp.reset();
    let nextSend = 0;
    const deliver = (upTo, at) => {
      while (nextSend + 20 <= upTo) {
        interp.push(snap(nextSend), at == null ? nextSend + 20 : at);
        nextSend += 1000 / 30;
      }
    };
    for (let now = 0; now < 2000; now += 1000 / 60) {
      deliver(now);
      interp.sample(now, 99);
    }
    const before = interp.info().delay;
    // 卡住：2000 → 2400ms 之间没有画帧，消息也没处理；2400ms 时一口气处理完
    deliver(2400, 2400);
    const late = [];
    for (let now = 2400; now < 4000; now += 1000 / 60) {
      deliver(now);
      interp.sample(now, 99);
      late.push(interp.info().delay);
    }
    const worst = Math.max(...late);
    check(worst < before + 25, `页面卡一下之后插值延迟不会被拉满（卡之前 ${before}ms，之后最多 ${worst}ms）`);
  }

  {
    // 插值不能改到原始快照（main.js 里的 state 还要用）
    interp.reset();
    const a = snap(0);
    const b = snap(33);
    interp.push(a, 0);
    interp.push(b, 33);
    const before = JSON.stringify([a, b]);
    for (let now = 30; now < 200; now += 10) interp.sample(now, 1);
    check(JSON.stringify([a, b]) === before, '插值不会改动收到的原始快照');
  }

  {
    // 跳跃高度 z 也要平滑：服务器 30Hz 发一个抛物线上的点，画面 60 帧每帧的高度变化要连续，
    // 快照断档时按抛物线外推（最高点附近不会一直往上飘），不会钻到地下
    const G = 1600;
    const V0 = K.JUMP_V;
    const zAt = (ms) => Math.max(0, V0 * (ms / 1000) - 0.5 * G * (ms / 1000) ** 2);
    const jumpSnap = (st) => {
      const s = snap(st);
      s.players[1] = { ...s.players[1], z: Math.round(zAt(st) * 10) / 10, vz: zAt(st) > 0 ? Math.round(V0 - G * (st / 1000)) : 0 };
      return s;
    };
    interp.reset();
    let nextSend = 0;
    const zs = [];
    for (let now = 0; now < 900; now += 1000 / 60) {
      while (nextSend + 20 <= now) {
        interp.push(jumpSnap(nextSend), nextSend + 20);
        nextSend += 1000 / 30;
      }
      const r = interp.sample(now, 99);
      if (r && r.state) zs.push(r.state.players.find((q) => q.id === 2).z);
    }
    const dz = zs.slice(1).map((z, i) => Math.abs(z - zs[i]));
    const top = Math.max(...zs);
    check(Math.max(...dz) < 10 && top > 85 && top < 100 && zs.every((z) => z >= 0), `跳跃高度逐帧平滑（每帧最多变化 ${Math.max(...dz).toFixed(1)}，最高 ${top.toFixed(0)}）`);

    // 断档：最后一个快照刚过最高点还在上升，外推时要按抛物线往回落
    interp.reset();
    for (let i = 0; i <= 9; i++) interp.push(jumpSnap(i * 33), i * 33 + 5);
    let peak = 0;
    for (let now = 300; now < 700; now += 16) peak = Math.max(peak, interp.sample(now, 99).state.players.find((q) => q.id === 2).z);
    check(peak < zAt(312) + 1, `断档时按抛物线外推，不会往上飘（外推最高 ${peak.toFixed(1)}，真实最高 ${zAt(312).toFixed(1)}）`);
  }

  console.log('Boss 砸地：画面上砸到地面的那一刻就是冲击波');
  {
    // 真的跑一个 Boss 房间：服务器 60Hz、每 2 帧发一个快照（JSON 走一遍），网络延迟 25ms，画面 60 帧
    const anim = await load('public/js/render/bossanim.js');
    const { makeRoom } = require('./helpers');
    const K = require('../server/constants');
    const DT = 1 / K.TICK_RATE;
    const { room } = makeRoom();
    room.applySettings({ map: 'lava', mode: 'boss', items: false });
    room.pickRandomMap = () => 'lava';
    room.startMatch();
    for (let i = 0; i < (K.COUNTDOWN + 0.1) / DT; i++) room.tick(DT);
    const me = room.list()[0];
    Object.assign(me, { x: 0, y: 330, vx: 0, vy: 0 });
    me.bot = false;
    me.afk = false;
    interp.reset();
    const snaps = [];
    let tick = 0;
    let firstBossT = null;
    // 等到 Boss 开始蓄力砸地（不然就强制它砸）
    const b = room.m.boss;
    Object.assign(b, { x: 0, y: 0, vx: 0, vy: 0, state: 'chase', stateT: 0.3 });
    b.fx.ghost = 0;
    const origRandom = Math.random;
    Math.random = () => 0.99; // 让它选"砸地"而不是"冲撞"
    for (let i = 0; i < 180; i++) {
      room.tick(DT);
      tick++;
      if (tick % 2 === 0) {
        const s = JSON.parse(JSON.stringify(room.snapshot()));
        s.st = (tick * 1000) / K.TICK_RATE;
        if (firstBossT === null && typeof s.m.bossT === 'number') firstBossT = s.m.bossT;
        snaps.push(s);
        room.events = [];
      }
    }
    Math.random = origRandom;
    check(firstBossT !== null && Math.abs(firstBossT - anim.SLAM_WIND) < 0.04, `客户端动画的蓄力时长和服务器一致（服务器 ${firstBossT}，客户端 ${anim.SLAM_WIND}）`);
    const hs = [];
    let slamFrame = -1;
    let soonFrame = -1;
    let si = 0;
    const t0 = snaps[0].st;
    for (let now = t0; now < snaps[snaps.length - 1].st; now += 1000 / 60) {
      while (si < snaps.length && snaps[si].st + 25 <= now) interp.push(snaps[si], snaps[si++].st + 25);
      const r = interp.sample(now, null);
      if (!r || !r.state) continue;
      const m = r.state.m || {};
      hs.push(anim.slamHeight(m.bossState === 'slamWind' ? m.bossT : null));
      if (r.events.some((e) => e.type === 'bossSlamSoon') && soonFrame < 0) soonFrame = hs.length - 1;
      if (r.events.some((e) => e.type === 'bossSlam') && slamFrame < 0) slamFrame = hs.length - 1;
    }
    const f = slamFrame;
    check(f > 30, `播到了砸地事件（第 ${f} 帧）`);
    check(hs[f] === 0 && hs[f - 1] < 25, `冲击波那一帧 Boss 正好落地（高度 ${hs[f].toFixed(0)}，前一帧 ${hs[f - 1].toFixed(0)}）`);
    const hover = hs[f - Math.round(0.35 * 60)];
    check(hover > 240, `砸下来前 0.35 秒 Boss 还停在空中（高度 ${hover.toFixed(0)}）`);
    const plunge = hs.slice(f - 17, f + 1);
    check(plunge.every((h, i) => i === 0 || h <= plunge[i - 1] + 0.01), '最后 0.3 秒一路往下砸，不会停顿或弹起');
    const lead = (f - soonFrame) / 60;
    check(soonFrame > 0 && Math.abs(lead - anim.SLAM_TELL) < 0.05, `"马上砸"的提示（呼啸、闪光）在落地前 ${lead.toFixed(2)} 秒播放（${anim.SLAM_TELL} 秒）`);
    check(anim.slamHeight(null) === 0 && anim.slamHeight(0) === 0 && anim.slamProgress(0) === 1, '不在蓄力时高度 0；砸下来那一刻红圈正好填满');
  }

  console.log('按显卡建议画质');
  const { suggestTier } = await load('public/js/render/gputier.js');
  const cases = [
    ['ANGLE (NVIDIA, NVIDIA GeForce GTX 650 (0x00000FC6) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (Intel, Intel(R) HD Graphics 4600 (0x00000412) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'low'],
    ['ANGLE (NVIDIA, NVIDIA GeForce GT 730 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['Adreno (TM) 506', 'low'],
    ['Adreno (TM) 618', 'medium'],
    ['Mali-G52 MC2', 'low'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', null],
    ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)', null],
    ['Apple GPU', null],
    ['', null],
  ];
  for (const [name, want] of cases) check(suggestTier(name) === want, `${name || '(空)'} → ${want || '默认画质'}`);
  done();
})();
