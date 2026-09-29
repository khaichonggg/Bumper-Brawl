// 跳跃：服务器权威的离地高度 z / 竖直速度 vz。
// 覆盖：滞空时间、跳过塌掉的地砖、土狼时间、预输入、不能二段跳、按高度判断碰撞、踩头，
// 以及各模式里"要站在地上"/"真的碰到才算"的规则
const { makeRoom, check, done } = require('./helpers');
const K = require('../server/constants');

const DT = 1 / K.TICK_RATE;

// 开一局：n 个人（除房主外都是机器人，但关掉 AI，由测试直接摆位置、给输入），跳过倒计时
function arena({ map = 'candy', mode = 'paint', n = 2, target } = {}) {
  const { room, host } = makeRoom();
  room.applySettings({ map, mode, items: false });
  room.pickRandomMap = () => map;
  if (target) room.applySettings({ target });
  for (let i = 1; i < n; i++) room.handle(host, { t: 'addBot' });
  room.startMatch();
  for (const p of room.list()) p.bot = false; // 不让 AI 动
  run(room, K.COUNTDOWN + 0.05);
  room.events = [];
  return { room, ps: room.list() };
}
// 推进 n 秒，返回期间的事件
function run(room, seconds, each) {
  const evs = [];
  const n = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < n; i++) {
    room.tick(DT);
    evs.push(...room.events);
    room.events = [];
    if (each && each(i) === false) break;
  }
  return evs;
}
function put(p, x, y, extra = {}) {
  Object.assign(p, { x, y, vx: 0, vy: 0, z: 0, vz: 0, falling: 0, alive: true, hanging: false, coyote: K.JUMP_COYOTE, sinceLand: 99 }, extra);
  p.fx.ghost = 0;
}
const input = (room, p, o) => room.handle(p, { t: 'input', x: 0, y: 0, ...o });
// 其他人都挪到远处的安全地砖上，免得挡路
function park(room, ps, keep) {
  const tiles = room.map.layout.tiles.filter((t, i) => room.tileState[i] === 0);
  let k = 0;
  for (const p of ps) {
    if (keep.includes(p)) continue;
    const t = tiles[(tiles.length - 1 - k++ * 3 + tiles.length) % tiles.length];
    put(p, t.cx, t.cy);
  }
}
const breakAt = (room, x, y) => {
  const id = room.tileAt(x, y);
  room.tileState[id] = 2;
  room.tileTimer[id] = Infinity;
  return id;
};

console.log('基本跳跃');
{
  const { room, ps } = arena();
  const [a] = ps;
  park(room, ps, [a]);
  put(a, 42, 42);
  input(room, a, { jump: true });
  let top = 0;
  let air = 0;
  let landed = null;
  const evs = run(room, 1.2, () => {
    top = Math.max(top, a.z);
    if (a.z > 0) air += DT;
    if (!landed && air > 0 && a.z === 0) landed = air;
  });
  check(evs.some((e) => e.type === 'jump' && e.id === a.id), '按跳会起跳，并广播 jump 事件');
  check(landed > 0.55 && landed < 0.7, `滞空 ${landed && landed.toFixed(2)} 秒（0.55~0.7）`);
  check(top > 85 && top < 95, `提高后的最高离地 ${top.toFixed(0)}（约 91）`);
  check(evs.some((e) => e.type === 'land' && e.id === a.id && e.v > 300), '落地时广播 land 事件（带落地速度）');
  check(a.alive && !a.falling && a.z === 0 && a.vz === 0, '落回地面，站稳');
  const snap = room.snapshot().players.find((q) => q.id === a.id);
  check(typeof snap.z === 'number' && typeof snap.vz === 'number' && snap.hole === 0, '快照里带 z / vz');
}

console.log('不能二段跳 / 预输入');
{
  const { room, ps } = arena();
  const [a] = ps;
  park(room, ps, [a]);
  put(a, 42, 42);
  input(room, a, { jump: true });
  let top = 0;
  let evs = run(room, 0.3, () => void (top = Math.max(top, a.z)));
  input(room, a, { jump: true }); // 在最高点附近再按一次
  evs = evs.concat(run(room, 1.2, () => void (top = Math.max(top, a.z))));
  check(evs.filter((e) => e.type === 'jump').length === 1 && top < 95, '空中再按跳不会二段跳，也不会在落地时补跳（按得太早）');

  // 落地前 0.08 秒按：不会丢，落地硬直（0.22 秒）一过就跳；紧接着的"连跳"低一些
  put(a, 42, 42);
  input(room, a, { jump: true });
  let t = 0;
  let landT = null;
  let jump2T = null;
  let top2 = 0;
  evs = run(room, 1.5, () => {
    t += DT;
    if (Math.abs(t - 0.57) < DT / 2) input(room, a, { jump: true });
    if (landT === null && t > 0.1 && a.z === 0 && a.vz === 0) landT = t;
    if (landT !== null && jump2T === null && a.vz > 0) jump2T = t;
    if (jump2T !== null) top2 = Math.max(top2, a.z);
  });
  const jumps = evs.filter((e) => e.type === 'jump');
  const wait = jump2T - landT;
  check(jumps.length === 2 && wait > K.JUMP_RECOVER - 0.03 && wait < K.JUMP_RECOVER + 0.04, `落地前 0.08 秒按下的跳不会丢，落地硬直结束就起跳（落地后 ${wait.toFixed(2)} 秒）`);
  check(top2 > 30 && top2 < 49, `紧接着的连跳低一些（最高 ${top2.toFixed(0)}，越不过别人头顶）`);
}

console.log('一直按跳：大部分时间还是在地上');
{
  const { room, ps } = arena();
  const [a] = ps;
  park(room, ps, [a]);
  put(a, 42, 42);
  let air = 0;
  let high = 0;
  let n = 0;
  run(room, 6, () => {
    input(room, a, { jump: true }); // 每一帧都按
    n++;
    if (a.z > 0 || a.vz > 0) air++;
    if (a.z > 48) high++;
  });
  check(air / n < 0.7, `每帧都按跳：在空中的时间 ${Math.round((air / n) * 100)}%（< 70%）`);
  check(high / n < 0.1, `每帧都按跳：高过别人头顶的时间 ${Math.round((high / n) * 100)}%（< 10%）`);
  // 已经连跳了一阵子的人：冲刺在跳跃节奏的任何时刻撞过来都能撞中（不会被"免费踩头"弹开）
  let hits = 0;
  let stomps = 0;
  const tries = 30;
  for (let k = 0; k < tries; k++) {
    const r = arena({ map: 'candy', mode: 'classic', n: 3 });
    const [p, q] = r.ps;
    park(r.room, r.ps, [p, q]);
    put(p, 100, 110);
    put(q, -300, 110);
    const dashAt = 120 + k * 2; // 扫过一整个跳跃节奏（约 43 帧）
    let hit = false;
    for (let i = 0; i < dashAt + 60; i++) {
      input(r.room, p, { jump: true });
      const go = i >= dashAt - 24;
      input(r.room, q, { x: go ? 1 : 0, dash: i === dashAt });
      if (!go) Object.assign(q, { x: -300, vx: 0 });
      r.room.tick(DT);
      if (r.room.events.some((e) => e.type === 'stomp')) stomps++;
      r.room.events = [];
      if (p.vx > 120) hit = true;
    }
    if (hit) hits++;
  }
  check(hits / tries >= 0.9 && stomps === 0, `一直按跳的人被冲刺撞中 ${hits}/${tries} 次，连跳落下来也没有踩到冲过来的人（踩头 ${stomps} 次）`);

  // 站稳歇一会儿再跳：又是满高度
  run(room, 1.2);
  input(room, a, { jump: true });
  let top = 0;
  run(room, 0.8, () => void (top = Math.max(top, a.z)));
  check(top > 70, `站稳之后再跳是满高度（${top.toFixed(0)}）`);
}

console.log('被炸飞 / 踩头弹起：没有土狼时间，不能在洞上再起跳');
{
  const { room, ps } = arena();
  const [a] = ps;
  park(room, ps, [a]);
  put(a, 42, -126, { vz: 300 }); // 站着被炸弹往上掀（knock 只改 vz）
  breakAt(room, 42, -126);
  let tick = 0;
  let landTick = -1;
  let fallTick = -1;
  const evs = run(room, 0.8, () => {
    tick++;
    if (a.vz < 0) input(room, a, { jump: true }); // 往下落的时候一直按跳
    if (landTick < 0 && a.z === 0 && a.vz === 0) landTick = tick;
    if (a.falling) {
      fallTick = tick;
      return false;
    }
  });
  check(!evs.some((e) => e.type === 'jump'), '被掀到空中后落在洞上：不能再起跳');
  check(a.falling > 0 && fallTick === landTick, `被掀到空中后落在洞上：落地那一帧就开始掉（落地第 ${landTick} 帧，掉落第 ${fallTick} 帧）`);
}

console.log('跳过塌掉的地砖 / 土狼时间');
{
  // 糖果地图：一排 84 宽的方砖。把 x∈[0,84) 那块打掉，从左边跑过来
  const attempt = ({ jumpAtX = null, jumpAfterEdge = null } = {}) => {
    const { room, ps } = arena();
    const [a] = ps;
    park(room, ps, [a]);
    breakAt(room, 42, -126);
    put(a, -250, -126, { vx: 458 });
    let jumped = false;
    let offEdge = 0;
    let fellAfter = null;
    run(room, 1.6, (i) => {
      input(room, a, { x: 1 });
      if (a.x >= 0 && a.z === 0 && a.x < 84) offEdge++;
      if (!jumped && jumpAtX !== null && a.x >= jumpAtX) {
        input(room, a, { x: 1, jump: true });
        jumped = true;
      }
      if (!jumped && jumpAfterEdge !== null && offEdge >= jumpAfterEdge) {
        input(room, a, { x: 1, jump: true });
        jumped = true;
      }
      if (a.falling && fellAfter === null) fellAfter = offEdge;
      return i < 200;
    });
    return { a, fellAfter };
  };
  const plain = attempt();
  check(plain.a.falling > 0 || !plain.a.alive, '不跳：走进塌掉的地砖会掉下去');
  check(plain.fellAfter >= 4 && plain.fellAfter <= 8, `土狼时间：走出边缘后约 ${plain.fellAfter} 帧（0.1 秒）才开始掉`);
  const hop = attempt({ jumpAtX: -20 });
  check(hop.a.alive && !hop.a.falling && hop.a.x > 100, `边缘起跳能跳过一块塌掉的地砖（落在 x=${Math.round(hop.a.x)}）`);
  const late = attempt({ jumpAfterEdge: 3 });
  check(late.a.alive && !late.a.falling && late.a.x > 100, '走出边缘 3 帧后才按跳（土狼时间内）也能跳过去');
  const tooLate = attempt({ jumpAfterEdge: 9 });
  check(tooLate.a.falling > 0 || !tooLate.a.alive, '土狼时间过了再按跳：已经掉下去了');

  // 落到洞上：落地那一刻开始掉
  const { room, ps } = arena();
  const [a] = ps;
  park(room, ps, [a]);
  breakAt(room, 42, -126);
  put(a, 42, -126, { z: 40, vz: 0 });
  const evs = run(room, 0.5);
  check(evs.some((e) => e.type === 'fall' && e.id === a.id), '在空中不检查脚下，落在洞上才掉下去');
  const snapHole = (() => {
    put(a, 42, -126, { z: 40, vz: 100 });
    return room.snapshot().players.find((q) => q.id === a.id).hole;
  })();
  check(snapHole === 1, '空中且脚下没地面：快照标记 hole（客户端不画影子）');
}

console.log('碰撞看高度 / 踩头');
{
  const dashAt = (bJumps) => {
    const { room, ps } = arena({ n: 3 });
    const [a, b] = ps;
    park(room, ps, [a, b]);
    put(a, -260, -126, { vx: 458 });
    put(b, 0, -126);
    input(room, a, { x: 1, dash: true });
    if (bJumps) input(room, b, { jump: true });
    const evs = run(room, 0.9, () => void input(room, a, { x: 1 }));
    return { a, b, hit: evs.some((e) => e.type === 'hit' && [e.a, e.b].includes(a.id) && [e.a, e.b].includes(b.id)) };
  };
  const stay = dashAt(false);
  check(stay.hit && stay.b.x > 20, '站着不动：被冲刺撞飞');
  const hop = dashAt(true);
  check(!hop.hit && hop.a.x > hop.b.x && Math.abs(hop.b.x) < 5, '及时跳起：对方从脚下冲过去，没有撞到');

  // 踩头
  const { room, ps } = arena({ n: 3 });
  const [a, b] = ps;
  park(room, ps, [a, b]);
  put(a, 0, 42, { z: 40, vz: -300 });
  put(b, 10, 42);
  const evs = run(room, 1 / 60);
  check(evs.some((e) => e.type === 'stomp' && e.a === a.id && e.b === b.id), '从上面落到别人头上：踩头事件');
  check(a.vz > 250 && b.vx > 50 && b.alive && !b.falling && b.z === 0, `踩的人弹起来（vz=${Math.round(a.vz)}），被踩的人只被轻轻挤开（vx=${Math.round(b.vx)}）`);
  check(b.lastHitBy === a.id, '被踩后掉下去算踩的人击飞');
  put(a, 0, 42, { z: 40, vz: -300 });
  put(b, 10, 42, { stompCd: b.stompCd });
  const again = run(room, 1 / 60);
  check(!again.some((e) => e.type === 'stomp'), '刚被踩过的人短时间内不会被连续踩');

  // 人堆里：一次腾空最多踩两个头，不会一路踩着别人的头飞好几秒
  const crowd = arena({ n: 6 });
  const [t0, ...heads] = crowd.ps;
  heads.forEach((h, i) => put(h, -168 + i * 84, -126));
  put(t0, -178, -126, { z: 40, vz: -300 });
  heads.forEach((h) => (h.home = h.x));
  let chain = 0;
  let airT = 0;
  run(crowd.room, 3, () => {
    // 一直匀速往右飘，每次弹起来正好落到下一个头上；被踩的人原地不动
    t0.vx = 187;
    t0.vy = 0;
    t0.y = -126;
    heads.forEach((h) => Object.assign(h, { vx: 0, vy: 0, x: h.home, y: -126 }));
    if (t0.z > 0 || t0.vz > 0) airT += DT;
    else return false;
  }).forEach((e) => {
    if (e.type === 'stomp' && e.a === t0.id) chain++;
  });
  check(chain <= K.STOMP_CHAIN && airT < 1.4, `一次腾空最多踩 ${K.STOMP_CHAIN} 个头（踩了 ${chain} 个，在空中 ${airT.toFixed(2)} 秒）`);
}

console.log('站在地上的碰撞范围和以前一样（按水平距离）');
{
  const { room, ps } = arena({ mode: 'boss', map: 'lava', n: 2 });
  const [a] = ps;
  const boss = room.m.boss;
  park(room, ps, [a]);
  const touch = (d) => {
    put(boss, 0, 0);
    boss.fx.ghost = 0;
    boss.state = 'tired';
    boss.stateT = 99;
    put(a, d, 0, { vx: -1 });
    room.collide([a, boss]);
    return a.x !== d;
  };
  check(touch(83) && !touch(85), 'Boss（半径 60）和站在地上的人：水平距离 84 以内就碰到');
  // 大个子（变大道具）和普通人
  const r2 = arena({ n: 3 });
  const [p, q] = r2.ps;
  park(r2.room, r2.ps, [p, q]);
  p.fx.big = 5;
  const big = 24 * 1.55 + 24;
  put(q, 0, 126);
  put(p, -(big - 1), 126);
  p.fx.big = 5;
  r2.room.collide([p, q]);
  const near = q.x !== 0;
  put(q, 0, 126);
  put(p, -(big + 1), 126);
  p.fx.big = 5;
  r2.room.collide([p, q]);
  check(near && q.x === 0, `变大的人和普通人：水平距离 ${big.toFixed(0)} 以内就碰到`);
}

console.log('冲刺方向：站着不动时往面朝的方向冲');
{
  const { room, ps } = arena();
  const [a] = ps;
  park(room, ps, [a]);
  put(a, -126, 126, { dashCd: 0 });
  room.handle(a, { t: 'input', x: 0, y: 0, dash: true, fx: 0, fy: -1 });
  run(room, DT);
  check(a.vy < -500 && Math.abs(a.vx) < 1, `站着不动、没按方向键：往面朝的方向冲（vy=${Math.round(a.vy)}）`);
  put(a, -126, 126, { dashCd: 0 });
  room.handle(a, { t: 'input', x: 1, y: 0, dash: true, fx: 0, fy: -1 });
  run(room, DT);
  check(a.vx > 500 && Math.abs(a.vy) < 1, '按着方向键：还是往方向键的方向冲');
  put(a, -126, 126, { dashCd: 0, vx: -120, vy: -90 });
  room.handle(a, { t: 'input', x: 0, y: 0, dash: true, fx: 1, fy: 0 });
  run(room, DT);
  check(a.vx > 450, `没按方向键、身上还在滑：也往面朝的方向（准星）冲（vx=${Math.round(a.vx)}）`);
  put(a, -126, 126, { dashCd: 0 });
  room.handle(a, { t: 'input', x: 0, y: 0, dash: true });
  run(room, DT);
  check(Math.hypot(a.vx, a.vy) < 1, '旧客户端没发朝向：站着不动冲不出去（和以前一样）');
}

console.log('机器人不会老是跳开别人的冲刺');
{
  // 真人从约 290 远的地方冲刺撞过去；机器人不重新规划路线，只剩每帧的跳跃反射
  const trial = (lvl) => {
    const { room, host } = makeRoom();
    room.applySettings({ map: 'candy', mode: 'classic', items: false, botLevel: lvl });
    room.pickRandomMap = () => 'candy';
    room.handle(host, { t: 'addBot' });
    room.startMatch();
    run(room, K.COUNTDOWN + 0.05);
    const bot = room.list().find((p) => p.bot);
    put(host, -230, 110, { vx: 300 });
    put(bot, 60, 110, { botThink: 5 });
    bot.input.x = bot.input.y = 0;
    // 冲刺后 0.4 秒内撞上才算"这一下冲刺撞到了"（之后掉头再慢慢撞上不算）
    let hit = false;
    let jumps = 0;
    for (let i = 0; i < 60; i++) {
      const dx = bot.x - host.x;
      const dy = bot.y - host.y;
      const d = Math.hypot(dx, dy) || 1;
      room.handle(host, { t: 'input', x: dx / d, y: dy / d, dash: i === 8 });
      room.tick(DT);
      for (const e of room.events) {
        if (e.type === 'hit' && [e.a, e.b].includes(bot.id) && i <= 8 + 24) hit = true;
        if (e.type === 'jump' && e.id === bot.id) jumps++;
      }
      room.events = [];
    }
    return { hit, jumps };
  };
  const stats = [1, 2].map((lvl) => {
    let hits = 0;
    let multi = 0;
    const N = 160;
    for (let k = 0; k < N; k++) {
      const r = trial(lvl);
      if (r.hit) hits++;
      if (r.jumps > 1) multi++;
    }
    return { lvl, rate: hits / N, multi };
  });
  check(stats[0].rate >= 0.75, `普通机器人：冲刺撞上的比例 ${Math.round(stats[0].rate * 100)}%（>= 75%）`);
  check(stats[1].rate >= 0.6, `困难机器人：冲刺撞上的比例 ${Math.round(stats[1].rate * 100)}%（>= 60%，偶尔会跳开）`);
  check(stats.every((x) => x.multi === 0), '同一次冲刺机器人最多跳一次');
}

console.log('冲刺 / 跳 在倒计时、冰冻、吊着时无效；技能输入');
{
  const { room, host } = makeRoom();
  room.applySettings({ map: 'candy', mode: 'paint', items: false });
  room.pickRandomMap = () => 'candy';
  room.startMatch();
  room.tick(DT);
  input(room, host, { jump: true, dash: true });
  const evs = run(room, K.COUNTDOWN + 0.3);
  check(!evs.some((e) => e.type === 'jump' || e.type === 'dash'), '倒计时里按的跳 / 冲刺不会留到开局');
  host.fx.frozen = 1;
  input(room, host, { jump: true });
  run(room, 0.1);
  check(host.z === 0, '被冰冻时不能跳');
  host.fx.frozen = 0;
  host.hanging = true;
  input(room, host, { jump: true });
  run(room, 0.1);
  check(host.z === 0, '被绳子吊着时不能跳');
  host.hanging = false;
  input(room, host, { skill: true });
  const had = host.input.skill === true;
  run(room, DT);
  check(had && host.input.skill === false, '非 Boss 模式也会收下并清除技能输入');
}

console.log('Boss 震荡波');
{
  const { room, ps } = arena({ mode: 'boss', map: 'lava', n: 2 });
  const [p] = ps;
  const b = room.m.boss;
  park(room, ps, [p]);
  put(b, 0, 0, { state: 'tired', stateT: 99 });
  put(p, -250, 0);
  input(room, p, { skill: true, fx: 1 });
  const evs = run(room, DT);
  check(b.vx > 0 && b.lastHitBy === p.id, '朝向 Boss 的震荡波会把 Boss 击退并记录贡献者');
  check(evs.some((e) => e.type === 'bossSkill' && e.hit), '震荡波会广播命中反馈');
  check(p.skillCd > 3 && p.stats.dmg > 0, '命中后进入冷却并计入玩家贡献');
  const tiredPush = b.vx;
  p.skillCd = 0;
  put(b, 0, 0, { state: 'charge', stateT: 99, massMul: 1, damping: 3.4 });
  put(p, -250, 0);
  input(room, p, { skill: true, fx: 1 });
  run(room, DT);
  check(b.vx > 0 && b.vx < tiredPush, 'Boss 没累趴时仍会被震荡波击退，但力度较弱');
  const damage = p.stats.dmg;
  input(room, p, { skill: true, fx: 1 });
  const blocked = run(room, DT);
  check(p.stats.dmg === damage && !blocked.some((e) => e.type === 'bossSkill'), '冷却期间不能连续发射');
  p.skillCd = 1;
  room.placePlayer(p, -250, 0);
  check(p.skillCd === 0, '复活或开新回合后技能冷却会重置');
}

console.log('道具 / 场地');
{
  const { room, ps } = arena({ n: 3 });
  const [a, b] = ps;
  park(room, ps, [a, b]);
  room.traps.push({ id: 900, x: 0, y: 42, owner: 0, arm: 0, life: 20 });
  put(a, 0, 42, { z: 30, vz: 0 });
  run(room, DT);
  check(a.fx.slip === 0 && room.traps.length === 1, '在空中经过香蕉皮不会滑倒');
  put(b, 0, 42);
  run(room, DT);
  check(b.fx.slip > 0, '站在地上踩到香蕉皮会滑倒');

  // 炸弹：把人往上掀
  put(a, 0, 126);
  put(b, 60, 126);
  a.item = 'bomb';
  room.useItem(a);
  check(b.vz > 100 && b.vx > 300, `炸弹把人炸飞时也往上掀（vz=${Math.round(b.vz)}）`);
  void a;
  run(room, 1);
  // 软糖弹簧：跳得够高就从上面越过去
  const bp = room.map.bumpers[0];
  put(a, bp.x - 50, bp.y, { z: bp.r * 1.4, vz: 0, vx: 300 });
  const bumps = run(room, DT).filter((e) => e.type === 'bump');
  check(bumps.length === 0, '从软糖弹簧上面跳过去不会被弹');
}

console.log('复活 / 掉落重置高度');
{
  const { room, ps } = arena();
  const [a] = ps;
  park(room, ps, [a]);
  put(a, 5000, 5000, { z: 0 });
  run(room, 0.2);
  check(a.falling > 0, '掉出场地');
  run(room, 4);
  check(a.alive && a.z === 0 && a.vz === 0, '复活后站在地上（z=0）');
}

console.log('足球：球不离地，跳得高踢不到球');
{
  const { room, ps } = arena({ mode: 'football', map: 'lava', n: 3 });
  const ball = room.m.ball;
  const [a] = ps;
  park(room, ps, [a]);
  put(ball, 0, 0);
  ball.lastTouch = null;
  put(a, 0, 20, { z: 75, vz: 0, vx: 200 });
  run(room, DT);
  check(ball.lastTouch === null && Math.hypot(ball.vx, ball.vy) < 1, '在球正上方高高跳过：碰不到球');
  put(a, -70, 0, { z: 8, vz: 0, vx: 500 });
  run(room, 0.12);
  check(ball.lastTouch === a.id && ball.vx > 100, '跳得低（贴地）还是能踢到球');
  room.knock(ball.x, ball.y, 200, 900, null, null, 400);
  check(!(ball.z > 0) && !(ball.vz > 0), '炸弹 / 冲击波只掀人，球始终在地上');
}

console.log('涂色：只有踩在地上才涂');
{
  const { room, ps } = arena({ mode: 'paint' });
  const [a] = ps;
  park(room, ps, [a]);
  const id1 = room.tileAt(-126, 126);
  const id2 = room.tileAt(126, 126);
  room.m.owner[id1] = room.m.owner[id2] = -1;
  put(a, -126, 126);
  run(room, DT);
  const slot = room.m.slots.indexOf(a.id);
  check(room.m.owner[id1] === slot, '站在地上：脚下的地砖变成自己的颜色');
  put(a, 126, 126, { z: 50, vz: 0 });
  run(room, DT);
  check(room.m.owner[id2] === -1, '跳在空中：经过的地砖不涂色');
}

console.log('烫手炸弹：真的撞上才传');
{
  const { room, ps } = arena({ mode: 'potato', map: 'candy', n: 3 });
  const [a, b] = ps;
  park(room, ps, [a, b]);
  room.m.holder = a.id;
  room.m.fuse = room.m.fuseMax = 30;
  room.m.passCd = 0;
  put(a, -60, 126, { z: 70, vz: 0, vx: 500 });
  put(b, 0, 126);
  run(room, 0.1);
  check(room.m.holder === a.id, '拿炸弹的人从别人头顶跳过去：炸弹不会传过去');
  put(a, -60, 126, { vx: 500 });
  put(b, 0, 126);
  run(room, 0.15, () => void input(room, a, { x: 1 }));
  check(room.m.holder === b.id, '在地上撞到人：炸弹传过去');

  // 在空中爆炸：出局的人不留在半空
  put(b, 0, 126, { z: 40, vz: 200 });
  room.m.holder = b.id;
  room.m.fuse = 0.001;
  run(room, DT);
  check(!b.alive && b.exploded && b.z === 0 && b.vz === 0, '拿着炸弹在空中爆炸：出局后 z 归零');
}

console.log('Boss 砸地：跳起来能躲开');
{
  const { room, ps } = arena({ mode: 'boss', map: 'lava', n: 3 });
  const [a, b] = ps;
  const boss = room.m.boss;
  park(room, ps, [a, b]);
  put(boss, 0, 0);
  boss.fx.ghost = 0;
  boss.state = 'slamWind';
  boss.stateT = DT / 2;
  put(a, 120, 0, { z: 40, vz: 0 });
  put(b, -120, 0);
  const evs = run(room, DT);
  check(evs.some((e) => e.type === 'bossSlam'), 'Boss 砸地');
  evs.push(...run(room, 0.2));
  check(Math.abs(a.vx) < 1 && b.vx < -300, `砸地那一刻跳在空中的人不受影响，站在地上的人被震飞（vx=${Math.round(b.vx)}）`);

  // 宽限：相对服务器砸下来的那一刻，什么时候按跳能躲开
  const slamAt = (jumpAt) => {
    const r = arena({ mode: 'boss', map: 'lava', n: 2 });
    const [p] = r.ps;
    const bs = r.room.m.boss;
    park(r.room, r.ps, [p]);
    put(bs, 0, 0, { state: 'slamWind', stateT: 0.5, told: false });
    bs.fx.ghost = 0;
    put(p, 120, 0);
    let t = -0.5;
    let knocked = false;
    const ev = run(r.room, 1.2, () => {
      t += DT;
      if (Math.abs(t - jumpAt) < DT / 2) input(r.room, p, { jump: true });
      if (Math.hypot(p.vx, p.vy) > 200) knocked = true;
    });
    return { knocked, ev };
  };
  const cases = [-0.45, -0.2, -0.05, 0, 0.05, 0.12];
  const ok = cases.every((j) => !slamAt(j).knocked);
  check(ok, `砸下来前 0.45 秒到砸下来后 0.12 秒之间按跳都能躲开（按键传到服务器要时间）`);
  const late = slamAt(0.3);
  check(late.knocked, '砸下来 0.3 秒后才按跳：被震飞');
  const still = slamAt(99);
  check(still.knocked, '不跳也不跑：被震飞');
  const tell = still.ev.find((e) => e.type === 'bossSlamSoon');
  check(!!tell, '砸下来前发出"马上砸"的提示事件（客户端停住、闪光、呼啸）');

  // 快照里带"离砸下来还有几秒"，客户端按它播动画
  put(boss, 0, 0, { state: 'slamWind', stateT: 0.8 });
  const sm = room.snapshot().m;
  check(Math.abs(sm.bossT - 0.8) < 0.01, `快照里带 bossT（${sm.bossT}）`);
  boss.state = 'tired';
  check(room.snapshot().m.bossT === null, '不在蓄力砸地时 bossT 是 null');

  // 协作模式里踩到队友：只轻轻碰一下（第三个人刚才被震飞了，先挪回远处）
  park(room, ps, [a, b]);
  put(boss, 400, 400);
  put(a, 0, 150, { z: 40, vz: -300 });
  put(b, 10, 150);
  const st = run(room, DT);
  check(st.some((e) => e.type === 'stomp') && b.vx > 0 && b.vx < 120, `协作模式踩到队友只轻轻挤一下（vx=${Math.round(b.vx)}）`);

  // 机器人会跳起来躲砸地（来不及跑出范围的时候）
  let dodged = 0;
  let total = 0;
  for (let k = 0; k < 6; k++) {
    const r = arena({ mode: 'boss', map: 'lava', n: 4 });
    for (const p of r.room.list()) p.bot = true;
    r.room.settings.botLevel = 2;
    const bs = r.room.m.boss;
    put(bs, 0, 0, { state: 'slamWind', stateT: 0.42, slams: 99 + k });
    bs.fx.ghost = 0;
    const near = r.room.list();
    // 思考间隔拉满：机器人不会跑开，只剩每帧的跳跃反射
    near.forEach((p, i) => put(p, Math.cos(i * 1.6) * 110, Math.sin(i * 1.6) * 110, { botThink: 99 }));
    run(r.room, 0.6, () => {
      if (bs.state === 'slamWind') return;
      // 砸下去的这一帧：还在范围里的人有几个跳起来了
      const inRange = near.filter((p) => Math.hypot(p.x - bs.x, p.y - bs.y) < 230 + 24);
      total += inRange.length;
      dodged += inRange.filter((p) => p.z > 10).length;
      return false;
    });
  }
  check(total > 0 && dodged / total >= 0.7, `困难机器人来不及跑开时会跳起来躲砸地（${dodged}/${total}）`);
}

console.log('绳索闯关');
{
  // 第 2 关：压力板要站在上面踩住
  const { room, ps } = arena({ mode: 'rope', map: 'lava', n: 2 });
  room.round = 1;
  room.startRound();
  for (const p of room.list()) p.bot = false;
  run(room, K.COUNTDOWN + 0.05);
  const [a, b] = ps;
  const [p0, p1] = room.m.plates;
  put(a, p0.x, p0.y + 76, { z: 0 }); // 先站在旁边
  put(b, p0.x + 20, p0.y + 76);
  run(room, DT);
  put(a, p0.x, p0.y, { z: 30, vz: 0 });
  run(room, DT);
  check(!room.m.plates[0].on, '跳在压力板上方：不算踩住');
  put(a, p0.x, p0.y);
  run(room, DT);
  check(room.m.plates[0].on, '站在压力板上：踩住');
  void p1;

  // 第 1 关：一个人冲刺 + 跳 + 土狼时间也飞不过 6 格宽的断桥
  const crossGap = (stage, mapId, setup) => {
    const r = makeRoom();
    r.room.applySettings({ map: mapId, mode: 'rope' });
    r.room.pickRandomMap = () => mapId;
    r.room.startMatch();
    if (stage) {
      r.room.round = stage;
      r.room.startRound();
    }
    run(r.room, K.COUNTDOWN + 0.05);
    return setup(r.room, r.host);
  };
  let best = -Infinity;
  let crossed = false;
  for (const mapId of ['lava', 'ice']) {
    for (const dashLead of [0, 4, 8, 14, 20]) {
      for (const jumpAfter of [-3, 0, 2, 4, 5]) {
        crossGap(0, mapId, (room, p) => {
          const f = room.map.feat;
          const xs = f.kBridge.map((id) => room.map.layout.tiles[id]);
          const y = xs[0].cy;
          const gapL = Math.min(...xs.map((t) => t.cx)) - 38;
          const gapR = Math.max(...xs.map((t) => t.cx)) + 38;
          put(p, gapL - 200, y, { vx: 500 });
          let dashed = false;
          let jumped = false;
          let off = -99;
          run(room, 2.5, () => {
            input(room, p, { x: 1 });
            const ticksToEdge = (gapL - p.x) / (Math.max(1, p.vx) * DT);
            if (!dashed && ticksToEdge <= dashLead) {
              input(room, p, { x: 1, dash: true });
              dashed = true;
            }
            if (p.x >= gapL && off < 0) off = 0;
            else if (off >= 0) off++;
            const tte = Math.ceil(ticksToEdge);
            if (!jumped && ((jumpAfter < 0 && tte <= -jumpAfter) || (jumpAfter >= 0 && off >= jumpAfter))) {
              input(room, p, { x: 1, jump: true });
              jumped = true;
            }
            if (p.falling || !p.alive) return false;
          });
          best = Math.max(best, p.x - gapL);
          if (p.alive && !p.falling && p.x > gapR) crossed = true;
        });
      }
    }
  }
  check(!crossed, `闯关：冲刺 + 跳 + 土狼时间也飞不过 6 格宽的断桥（最远飞了 ${Math.round(best)}，断桥宽 456）`);

  // 冰面跑得比空中上限 480 快：正常跑着起跳不能被"刹车"
  const iceKeep = crossGap(0, 'ice', (room, p) => {
    const t = room.map.layout.tiles[room.map.feat.kBridge[0]];
    put(p, t.cx - 380, t.cy, { vx: 540 }); // 断桥前面只有 5 格：直接给到冰面上的跑步极速（约 543）
    run(room, 0.1, () => void input(room, p, { x: 1 }));
    const before = Math.hypot(p.vx, p.vy);
    input(room, p, { x: 1, jump: true });
    run(room, 0.25, () => void input(room, p, { x: 1 }));
    return { before, after: Math.hypot(p.vx, p.vy), air: p.z > 0 };
  });
  check(iceKeep.air && iceKeep.before > 500 && iceKeep.after > iceKeep.before * 0.97, `闯关（冰面）：跑着起跳不减速（起跳前 ${Math.round(iceKeep.before)}，空中 ${Math.round(iceKeep.after)}）`);

  // 第 3 关：闪烁地砖空出来的 2 格能跳过去
  const ok = crossGap(2, 'lava', (room, p) => {
    const f = room.map.feat;
    const tiles = room.map.layout.tiles;
    for (const id of f.blinkA) room.tileState[id] = 0;
    for (const id of f.blinkB) room.tileState[id] = 2;
    room.m.blink.t = 99;
    const row = f.blinkA.map((id) => tiles[id]).filter((t) => t.gj === tiles[f.blinkA[0]].gj).sort((q, w) => q.cx - w.cx);
    const firstRight = row[1].cx + 38; // 第一组 A 的右边缘
    put(p, row[0].cx - 20, row[0].cy);
    let jumped = false;
    run(room, 1.4, () => {
      input(room, p, { x: 1 });
      if (!jumped && p.x > firstRight - 25) {
        input(room, p, { x: 1, jump: true });
        jumped = true;
      }
      if (p.falling) return false;
    });
    return p.alive && !p.falling && p.x > firstRight + 152;
  });
  check(ok, '闯关：闪烁地砖空出来的两格能跳过去');
}

done();
