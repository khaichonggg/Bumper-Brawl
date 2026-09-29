// 每个模式 × 每张地图都用 8 个 AI 打一整场，检查能正常结束、没有异常数值
const { makeRoom, step, check, done } = require('./helpers');
const { MODES } = require('../server/modes');
const { MAPS } = require('../server/maps');

const LIMIT = 900; // 模拟时间上限（秒）
const summary = [];

// 草原地形：台阶只能逐级上，二楼与底层分别有支撑，草丛静止时会隐藏角色。
{
  const { room, host } = makeRoom();
  room.applySettings({ map: 'meadow' });
  host.x = -320;
  host.y = 300;
  room.updateElevation(host, -340, 300);
  check(host.floorZ === 12 && room.supported(host.x, host.y, host.floorZ), '草原：能走上第一层石阶并获得正确高度');
  for (const x of [-288, -256, -224, -192, -160, -128, -96, -79]) {
    const oldX = host.x;
    host.x = x;
    room.updateElevation(host, oldX, 300);
  }
  check(host.floorZ === 96 && room.supported(host.x, host.y, host.floorZ), '草原：能沿完整楼梯走到二楼');
  const oldX = host.x;
  host.x = -120;
  room.updateElevation(host, oldX, 300);
  check(host.floorZ === 84 && host.z === 0 && room.supported(host.x, host.y, host.floorZ), '草原：下楼时会逐级落脚');
  check(room.surfaceAt(0, 300, 0) === 0 && room.supported(0, 300, 0), '草原：高台下方仍可在底层通行');
  check(room.surfaceAt(0, 300, 96) === 96 && room.supported(0, 300, 96), '草原：楼梯连到可站立的二楼平台');
  const lower = room.addPlayer({ name: '楼下玩家' });
  host.x = lower.x = 0;
  host.y = lower.y = 300;
  lower.x = 20;
  host.floorZ = 96;
  lower.floorZ = 0;
  room.collide([host, lower]);
  check(host.x === 0 && lower.x === 20, '草原：上下楼层不会发生错误碰撞穿模');
  host.x = 0;
  host.y = 300;
  host.floorZ = 0;
  host.z = 100;
  host.vz = -1000;
  room.fly(host, 1 / 60);
  check(host.floorZ === 96 && host.z === 0, '草原：从上方落下会落在高台表面');
  host.floorZ = 0;
  host.z = 17;
  host.vz = 1000;
  room.fly(host, 1 / 60);
  check(host.z === 18 && host.vz === 0, '草原：站在高台下方跳跃不会穿过平台');
  host.x = room.map.bushes[0].x;
  host.y = room.map.bushes[0].y;
  host.vx = host.vy = host.z = 0;
  check(room.concealed(host), '草原：静止躲进草丛会隐藏');
  host.vx = 100;
  check(!room.concealed(host), '草原：离开静止状态后不再隐藏');
}

function runMatch(mapId, modeId, players = 8, target) {
  const originalRandom = Math.random;
  let seed = [...`${modeId}/${mapId}/${players}/${target || 0}`].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 2147483647, 1);
  Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  try {
  const { room, host } = makeRoom();
  host.afk = true; // 让 AI 托管房主
  room.applySettings({ map: mapId, mode: modeId });
  room.pickRandomMap = () => mapId; // 固定单测地图；正式对局仍随机抽取
  if (target) room.applySettings({ target });
  for (let i = 1; i < players; i++) room.handle(host, { t: 'addBot' });
  room.startMatch();
  const ev = {};
  let bad = null;
  let t = 0;
  while (room.phase !== 'gameOver' && t < LIMIT) {
    step(room, 5, (events) => {
      for (const e of events) ev[e.type] = (ev[e.type] || 0) + 1;
    });
    t += 5;
    for (const b of room.activeBodies()) {
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.vx)) bad = `${b.kind} ${b.id} 坐标异常`;
    }
    const snap = room.snapshot();
    JSON.stringify(snap); // 快照必须能序列化
  }
  return { room, ev, t, bad };
  } finally {
    Math.random = originalRandom;
  }
}

// 地图每场重抽；关闭地板坍塌时外圈和撞击都不会打穿地板。
{
  const { room: variety } = makeRoom();
  const picked = new Set();
  let previous = null;
  let noRepeat = true;
  for (let i = 0; i < Object.keys(MAPS).length * 3; i++) {
    const id = variety.pickRandomMap();
    if (id === previous) noRepeat = false;
    picked.add(id);
    previous = id;
  }
  check(noRepeat, '随机地图不会和上一场重复');
  check(picked.size === Object.keys(MAPS).length, '随机地图池包含全部地图');

  const { room } = makeRoom();
  room.applySettings({ mode: 'classic', floorCollapse: false });
  room.pickRandomMap = () => 'lava';
  room.startMatch();
  check(room.settings.map === 'lava' && room.map.id === 'lava', '开局使用抽中的随机地图');
  check(room.nextRingCollapse() === Infinity, '关闭地板坍塌后不再启动外圈塌陷');
  room.breakTile(0);
  check(room.tileState[0] === 0, '关闭地板坍塌后撞击不会打穿地板');
  room.pickRandomMap = () => 'space';
  room.startMatch();
  check(room.settings.map === 'space', '再次开局会重新抽取地图');
}

for (const modeId of Object.keys(MODES)) {
  for (const mapId of Object.keys(MAPS)) {
    const { room, ev, t, bad } = runMatch(mapId, modeId);
    const r = room.results;
    const ok = room.phase === 'gameOver' && r && r.rows.length === 8 && !bad;
    check(ok, `${modeId.padEnd(8)} @ ${mapId.padEnd(5)} 在 ${Math.round(room.matchTime)}s 内打完（${room.round} 局）${bad ? ' ' + bad : ''}`);
    summary.push({ modeId, mapId, time: Math.round(room.matchTime), rounds: room.round, ev, winners: r ? r.winners.length : 0, awards: r ? r.awards.map((a) => a.title).join('/') : '' });
  }
}

// 新模式的核心规则。
{
  const { room, host } = makeRoom();
  room.applySettings({ mode: 'teamBrawl', target: 3 });
  room.handle(host, { t: 'addBot' });
  room.startMatch();
  room.settings.target = 1;
  for (const p of room.list()) if (p.team === 1) p.alive = false;
  MODES.teamBrawl.check(room);
  const over = MODES.teamBrawl.matchOver(room);
  check(room.phase === 'roundEnd' && room.teamScore[0] === 1 && over?.winnerTeam === 0, '红蓝淘汰赛：赢下一局得分并达到目标后获胜');
}
{
  const { room, host } = makeRoom();
  room.applySettings({ mode: 'hideSeek' });
  room.handle(host, { t: 'addBot' });
  room.startMatch();
  const hunter = room.players.get(room.m.hunter);
  const hider = room.list().find((p) => p.id !== hunter.id);
  hider.fx.shield = hider.fx.ghost = 0;
  MODES.hideSeek.onCollide(room, hunter, hider, 100);
  MODES.hideSeek.check(room);
  check(room.m.tagged.has(hider.id) && !hider.alive && room.results?.hunterId === hunter.id, '追捕躲藏：被碰到后出局，抓完所有人时追捕者获胜');
}
{
  const { room, host } = makeRoom();
  room.applySettings({ mode: 'soloHill' });
  room.handle(host, { t: 'addBot' });
  room.startMatch();
  room.settings.target = 1;
  const owner = room.list()[0];
  owner.x = owner.y = owner.z = owner.vz = 0;
  for (const p of room.list().slice(1)) p.x = 180;
  MODES.soloHill.update(room, 1);
  MODES.soloHill.check(room);
  check(room.phase === 'gameOver' && room.results.winners[0] === owner.id, '个人抢点：中心最近的玩家累计时间并获胜');
}

// 新模式的核心规则：接触会传播感染，只有人数占优的一队能累计中心控制时间。
{
  const { room, host } = makeRoom();
  room.applySettings({ mode: 'infection' });
  room.handle(host, { t: 'addBot' });
  room.startMatch();
  const infected = room.players.get([...room.m.infected][0]);
  const survivor = room.list().find((p) => !room.m.infected.has(p.id));
  survivor.fx.shield = survivor.fx.ghost = 0;
  MODES.infection.onCollide(room, infected, survivor, 100);
  check(room.m.infected.has(survivor.id), '感染追逐：被撞中的幸存者加入感染方');
}
{
  const { room, host } = makeRoom();
  room.applySettings({ mode: 'hill' });
  room.handle(host, { t: 'addBot' });
  room.startMatch();
  const controlling = room.list().find((p) => p.team === 0);
  const rival = room.list().find((p) => p.team === 1);
  room.settings.target = 1;
  for (const p of room.list()) p.fx.ghost = 0;
  controlling.x = controlling.y = controlling.z = controlling.vz = 0;
  rival.x = 180;
  rival.y = rival.z = rival.vz = 0;
  MODES.hill.update(room, 1);
  MODES.hill.check(room);
  check(room.phase === 'gameOver' && room.results.winnerTeam === 0, '中心占点：人数占优后累计时间并获胜');
}
{
  const { room, host } = makeRoom();
  room.applySettings({ mode: 'captureFlag' });
  room.handle(host, { t: 'addBot' });
  room.startMatch();
  room.settings.target = 1;
  const player = room.list()[0];
  const flag = room.m.flags[1 - player.team];
  player.x = flag.x;
  player.y = flag.y;
  MODES.captureFlag.update(room, 0);
  check(flag.carrier === player.id, '夺旗：碰到敌旗后开始携带');
  player.x = room.m.bases[player.team].x;
  player.y = room.m.bases[player.team].y;
  MODES.captureFlag.update(room, 0);
  check(room.phase === 'gameOver' && room.results.winnerTeam === player.team, '夺旗：己方旗在家时带敌旗回基地得分获胜');
}
{
  const { room } = makeRoom();
  room.applySettings({ mode: 'gravityStorm' });
  room.startMatch();
  const player = room.list()[0];
  player.x = 100;
  player.y = player.vx = player.vy = 0;
  MODES.gravityStorm.update(room, 0.1);
  check(player.vx < 0, '引力风暴：向内阶段会把玩家拉向中心');
  room.m.gravityTime = 0.01;
  MODES.gravityStorm.update(room, 0.02);
  check(room.m.gravityPhase === 1 && room.events.some((e) => e.type === 'gravityShift'), '引力风暴：计时结束会广播方向变化');
}
{
  const { room } = makeRoom();
  room.applySettings({ mode: 'monsterWave' });
  room.startMatch();
  room.m.wave = 3;
  room.m.spawned = room.m.waveTotal[2];
  room.m.intermission = 0.01;
  room.bodies = [];
  MODES.monsterWave.update(room, 0.02);
  check(room.m.wave === 4 && room.bodies.some((b) => b.kind === 'boss'), '怪物浪潮：前三波结束后会生成最终 Boss');
}
{
  const { room, host } = makeRoom();
  room.applySettings({ mode: 'platformRace' });
  room.startMatch();
  const pad = room.m.platforms[0];
  check(room.landingSurface(pad.x, pad.y, 60) === pad.z, '浮台竞速：移动浮台可作为跳跃落脚面');
  host.x = pad.x;
  host.y = pad.y;
  host.floorZ = 0;
  host.z = 50;
  host.vz = -1000;
  room.fly(host, 1 / 60);
  check(host.floorZ === pad.z && host.z === 0 && room.supported(host.x, host.y, host.floorZ), '浮台竞速：玩家落上浮台后获得平台高度支撑');
  const before = { x: host.x, y: host.y };
  MODES.platformRace.beforePhysics(room, 0.1);
  check(Math.hypot(host.x - before.x, host.y - before.y) > 1 && room.supported(host.x, host.y, host.floorZ), '浮台竞速：站稳后随移动平台同行');
  MODES.platformRace.update(room, 0.01);
  check(host.score === 1, '浮台竞速：按顺序登台会推进检查点');
}

// 协作模式：1 人和 8 人、三种难度都能结束
for (const [n, d] of [
  [1, 1],
  [1, 3],
  [4, 2],
  [8, 3],
]) {
  const { room, t } = runMatch('lava', 'boss', n, d);
  const r = room.results;
  check(room.phase === 'gameOver' && r && r.coop, `boss ${n} 人 难度${d}：${r && r.coop ? (r.coop.win ? '胜利' : '失败') : '未结束'}，用时 ${Math.round(room.matchTime)}s`);
}

// 绳索闯关：1 / 3 / 8 人都能打通 4 关，地图在关卡之间正确切换
for (const [n, d, map] of [
  [1, 1, 'lava'],
  [3, 2, 'ice'],
  [8, 2, 'candy'],
]) {
  const { room } = runMatch(map, 'rope', n, d);
  const r = room.results;
  check(room.phase === 'gameOver' && r && r.coop, `rope ${n} 人 难度${d} @ ${map}：${r && r.coop ? (r.coop.win ? '通关' : '失败于第 ' + (r.coop.stage + 1) + ' 关') : '未结束'}，用时 ${Math.round(room.matchTime)}s`);
}
{
  // 回到大厅后地图恢复成房间选的地图
  const { room } = runMatch('space', 'rope', 2, 1);
  const inLevel = room.map.id.startsWith('rope-');
  room.toLobby();
  check(inLevel && room.map.id === 'space', '闯关结束回到大厅后，地图恢复成星际空间站');
}

// 模式特有的事件必须真的发生过
const has = (modeId, type) => summary.filter((s) => s.modeId === modeId).some((s) => s.ev[type] > 0);
check(has('football', 'goal'), '足球：有进球');
check(has('football', 'ballOut'), '足球：球出界后能重新发球');
check(has('crown', 'crown'), '抢皇冠：有人拿到 / 抢到皇冠');
check(has('potato', 'potatoPass'), '烫手炸弹：炸弹被传递');
check(has('potato', 'potatoBoom'), '烫手炸弹：引信烧完爆炸');
check(has('boss', 'bossDown'), 'Boss：被推下场');
check(has('boss', 'bossSlam') && has('boss', 'bossCharge'), 'Boss：会冲撞和砸地');
check(has('classic', 'collapse'), '经典：外圈坍塌');
check(has('rope', 'unlock') && has('rope', 'platesOpen') && has('rope', 'blink'), '闯关：开锁、压力板、闪烁地砖都触发了');
check(has('rope', 'hang') && has('rope', 'saved'), '闯关：踩空被绳子吊住，并被队友拉回来');
check(has('rope', 'stageClear'), '闯关：有关卡通过');
check(summary.some((s) => s.mapId === 'space' && s.ev.meteor > 0), '太空站：陨石雨');
check(summary.some((s) => s.mapId === 'candy' && s.ev.bump > 0), '糖果：弹簧');
for (const item of ['bomb', 'freeze', 'tornado', 'banana']) {
  const type = { bomb: 'shock', freeze: 'freeze', tornado: 'pickup', banana: 'slip' }[item];
  check(summary.some((s) => s.ev[type] > 0), `道具：${item} 生效`);
}

// 机器人会跳（躲冲刺、躲砸地、跳过缺口），但不会一直蹦
{
  const jumps = summary.reduce((n, s) => n + (s.ev.jump || 0), 0);
  const botSeconds = summary.reduce((n, s) => n + s.time * 8, 0);
  const perMin = (jumps / botSeconds) * 60;
  check(jumps > 0 && perMin < 12, `机器人偶尔会跳（平均每人每分钟 ${perMin.toFixed(1)} 次）`);
}

console.log('\n模式      地图   用时  局数  跳  奖项');
for (const s of summary) console.log(`${s.modeId.padEnd(9)} ${s.mapId.padEnd(6)} ${String(s.time).padStart(4)}s ${String(s.rounds).padStart(4)} ${String(s.ev.jump || 0).padStart(4)}  ${s.awards}`);
done();
