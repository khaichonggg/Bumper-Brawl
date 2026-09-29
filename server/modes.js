// 游戏模式：每个模式的规则写在这里，房间引擎（room.js）在固定时机调用这些钩子。
//
// 钩子一览（都是可选的）：
//   setup(room)                 比赛开始时
//   startRound(room)            每一局 / 每次开球，玩家摆好位置之后
//   spawn(room, p, i, list)     返回这一局的出生点 {x, y}
//   update(room, dt)            进行中每帧
//   control(room, body, dt)     控制非玩家物体（Boss、小怪）
//   onCollide(room, a, b, rel)  两个物体相撞
//   onPlayerFall(room, p, killer)
//   onBodyFall(room, body)      球 / Boss / 小怪开始掉落
//   onItem(room, p, item)       玩家捡到道具（在默认效果之后）
//   onTileBreak(room, id)
//   canRespawn(room, p)
//   check(room)                 判定本局 / 比赛是否结束
//   matchOver(room)             一局结束后：返回 { winners } 表示整场结束
//   snapshot(room)              发给客户端的模式数据
//   botGoal(room, p, ctx)       机器人的目标点 { x, y, dash }
//   accelMul(room, p)
//   beforeRound(room)           每一局开始、摆放玩家之前（闯关模式在这里换关卡地图）
//   constrain(room, active, dt) 每帧碰撞之后（闯关模式的绳子）
//   respawnPos(room, p)         复活位置
//   keepBroken(room, tileId)    塌掉的地砖是否不再长回来
// 其他可选字段：airSpeedCap —— 空中水平速度上限（闯关模式不让人"冲刺 + 跳"飞过断桥）
//
// 跳跃：玩家有离地高度 z。碰撞按真实高度判定（room.collide），所以"碰到才算"的规则（传炸弹、踢球、抢皇冠）
// 自然只在真的撞上时触发；"要站在地上"的规则（涂色、压力板、钥匙、出口）在这里用 airborne() 判断。
const { rand, dist, r1, emptyFx, radiusOf, massOf, airborne } = require('./util');
const { STAGES, getLevel } = require('./levels');
const { PLAYER_R } = require('./constants');

const alivePlayers = (room) => room.list().filter((p) => p.alive && !p.falling);

// 淘汰制：场上只剩一人（单人练习时剩 0 人）就结束这一局
function eliminationCheck(room) {
  const list = room.list();
  if (list.some((p) => p.falling > 0)) return;
  const standing = list.filter((p) => p.alive && !p.falling);
  const solo = room.participants <= 1;
  if (solo ? standing.length > 0 : standing.length > 1) return;
  const winner = !solo && standing[0];
  if (winner) winner.score++;
  room.endRound({ winnerId: winner ? winner.id : null, key: winner ? '{name} 赢了这局！' : '平局！', p: winner ? { name: winner.name } : {} });
}
const roundWinners = (room) => {
  const w = room.list().filter((p) => p.score >= room.settings.target);
  return w.length ? { winners: w.map((p) => p.id) } : null;
};

// ---------------------------------------------------------------------
// 经典乱斗：活到最后
// ---------------------------------------------------------------------
const classic = {
  id: 'classic',
  targets: [3, 5, 7],
  defaultTarget: 3,
  minPlayers: 2,
  hazards: { collapse: true, cracks: 'permanent', meteors: true },
  check: eliminationCheck,
  matchOver: roundWinners,
};

// Team knockout: each surviving team takes one round point.
const teamBrawl = {
  id: 'teamBrawl',
  targets: [3, 5, 7],
  defaultTarget: 3,
  minPlayers: 2,
  teams: true,
  hazards: { collapse: true, cracks: 'permanent', meteors: true },
  check(room) {
    if (room.list().some((p) => p.falling > 0)) return;
    const alive = alivePlayers(room);
    const teams = [0, 1].filter((team) => alive.some((p) => p.team === team));
    if (teams.length > 1) return;
    const team = teams[0] ?? -1;
    if (team >= 0) {
      room.teamScore[team]++;
      for (const p of room.list()) if (p.team === team) p.score++;
    }
    room.endRound({ winnerTeam: team, key: team < 0 ? '平局！' : team === 0 ? '红队赢了这局！' : '蓝队赢了这局！' });
  },
  matchOver(room) {
    const team = room.teamScore.findIndex((score) => score >= room.settings.target);
    if (team < 0) return null;
    return { winners: room.list().filter((p) => p.team === team).map((p) => p.id), winnerTeam: team };
  },
};

// Infection: survivors score time; players switch sides after a solid hit.
const infection = {
  id: 'infection',
  targets: [45, 60, 90],
  defaultTarget: 60,
  minPlayers: 2,
  respawn: true,
  respawnDelay: 1.5,
  hazards: { collapse: true, cracks: 'permanent', meteors: true },
  setup(room) {
    room.m.infected = new Set();
    room.m.clock = room.settings.target;
  },
  startRound(room) {
    const players = room.list();
    room.m.infected = new Set();
    const initial = players.length >= 6 ? 2 : 1;
    for (let i = 0; i < initial; i++) {
      const p = players.splice(Math.floor(Math.random() * players.length), 1)[0];
      room.m.infected.add(p.id);
    }
    room.m.clock = room.settings.target;
  },
  accelMul: (room, p) => (room.m.infected.has(p.id) ? 1.08 : 1),
  update(room, dt) {
    room.m.clock = Math.max(0, room.m.clock - dt);
    for (const p of room.list()) if (!room.m.infected.has(p.id)) p.score += dt;
  },
  onCollide(room, a, b, rel) {
    const infected = room.m.infected;
    if (rel < 80 || a.kind !== 'player' || b.kind !== 'player' || infected.has(a.id) === infected.has(b.id)) return;
    const from = infected.has(a.id) ? a : b;
    const to = from === a ? b : a;
    if (to.fx.shield > 0 || to.fx.ghost > 0 || to.falling) return;
    infected.add(to.id);
    from.stats.hits++;
    room.event({ type: 'infect', id: to.id, by: from.id });
  },
  check(room) {
    const players = room.list();
    const infected = room.m.infected;
    if (players.length && players.every((p) => infected.has(p.id))) {
      room.endMatch(players.map((p) => p.id), { text: '感染者获胜！' });
    } else if (room.m.clock <= 0) {
      room.endMatch(players.filter((p) => !infected.has(p.id)).map((p) => p.id), { text: '幸存者获胜！' });
    }
  },
  snapshot(room) {
    return { infected: [...room.m.infected], clock: r1(room.m.clock) };
  },
  botGoal(room, p, ctx) {
    const infected = room.m.infected.has(p.id);
    const targets = room.list().filter((q) => q.alive && !q.falling && room.m.infected.has(q.id) !== infected);
    const target = targets.sort((a, b) => dist(p, a) - dist(p, b))[0];
    if (!target) return null;
    if (infected) return { x: target.x, y: target.y, dash: dist(p, target) < 150 };
    const dx = p.x - target.x;
    const dy = p.y - target.y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / d) * 220 + (ctx.refuge.x - p.x) * 0.4, y: p.y + (dy / d) * 220 + (ctx.refuge.y - p.y) * 0.4, dash: d < 180 };
  },
};

// Hide and seek: the seeker stays the seeker; caught hiders sit out the rest of the match.
const hideSeek = {
  id: 'hideSeek',
  targets: [45, 60, 90],
  defaultTarget: 60,
  minPlayers: 2,
  respawn: true,
  respawnDelay: 1.5,
  hazards: { collapse: false, cracks: 'regen', meteors: true },
  setup(room) {
    room.m.tagged = new Set();
    room.m.clock = room.settings.target;
  },
  startRound(room) {
    const players = room.list();
    room.m.hunter = players[Math.floor(Math.random() * players.length)].id;
    room.m.tagged = new Set();
    room.m.clock = room.settings.target;
  },
  update(room, dt) {
    room.m.clock = Math.max(0, room.m.clock - dt);
    for (const p of room.list()) if (p.id !== room.m.hunter && !room.m.tagged.has(p.id)) p.score += dt;
  },
  onCollide(room, a, b, rel) {
    if (rel < 80 || a.kind !== 'player' || b.kind !== 'player') return;
    const hunter = room.m.hunter === a.id ? a : room.m.hunter === b.id ? b : null;
    const hider = hunter === a ? b : hunter === b ? a : null;
    if (!hider || room.m.tagged.has(hider.id) || hider.fx.shield > 0 || hider.fx.ghost > 0 || hider.falling) return;
    room.m.tagged.add(hider.id);
    hider.alive = false;
    hider.out = true;
    hider.respawn = 0;
    hunter.score++;
    hunter.stats.hits++;
    room.event({ type: 'hideTag', id: hider.id, by: hunter.id });
  },
  check(room) {
    const hunter = room.players.get(room.m.hunter);
    const hiders = room.list().filter((p) => p.id !== room.m.hunter);
    if (hunter && hiders.length && hiders.every((p) => room.m.tagged.has(p.id))) {
      room.endMatch([hunter.id], { text: '追捕者获胜！', hunterId: hunter.id });
    } else if (room.m.clock <= 0) {
      room.endMatch(hiders.filter((p) => !room.m.tagged.has(p.id)).map((p) => p.id), { text: '躲藏者获胜！', hunterId: room.m.hunter });
    }
  },
  snapshot(room) {
    return { hunter: room.m.hunter, tagged: [...room.m.tagged], clock: r1(room.m.clock) };
  },
  botGoal(room, p, ctx) {
    const tagged = room.m.tagged;
    const hunter = p.id === room.m.hunter;
    const targets = room.list().filter((q) => q.alive && !q.falling && (hunter ? q.id !== p.id && !tagged.has(q.id) : q.id === room.m.hunter));
    const target = targets.sort((a, b) => dist(p, a) - dist(p, b))[0];
    if (!target) return null;
    if (hunter) return { x: target.x, y: target.y, dash: dist(p, target) < 150 };
    const dx = p.x - target.x;
    const dy = p.y - target.y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / d) * 220 + (ctx.refuge.x - p.x) * 0.4, y: p.y + (dy / d) * 220 + (ctx.refuge.y - p.y) * 0.4, dash: d < 180 };
  },
};

// ---------------------------------------------------------------------
// 抢皇冠：戴着皇冠计时，撞人抢冠
// ---------------------------------------------------------------------
const CROWN_GUARD = 2;
const crown = {
  id: 'crown',
  targets: [20, 30, 45],
  defaultTarget: 20,
  minPlayers: 1,
  respawn: true,
  respawnDelay: 2.2,
  hazards: { collapse: false, cracks: 'regen', meteors: true },
  startRound(room) {
    const blocked = (room.map.bumpers || []).some((b) => Math.hypot(b.x, b.y) < b.r + 40);
    const t = blocked ? room.safeSpot(false) : null;
    room.m.crown = { holder: null, x: t ? t.cx : 0, y: t ? t.cy : 0, wait: 0, guard: 0 };
  },
  accelMul: (room, p) => (room.m.crown && room.m.crown.holder === p.id ? 0.95 : 1),
  update(room, dt) {
    const cr = room.m.crown;
    if (!cr.holder) {
      cr.wait -= dt;
      if (cr.wait > 0) return;
      const p = alivePlayers(room).find((q) => q.fx.ghost <= 0 && Math.hypot(q.x - cr.x, q.y - cr.y) < radiusOf(q) + 26);
      if (p) {
        cr.holder = p.id;
        cr.guard = CROWN_GUARD;
        room.event({ type: 'crown', id: p.id });
      }
      return;
    }
    cr.guard -= dt;
    const h = room.players.get(cr.holder);
    if (!h) return crown.drop(room, 0, 0);
    // 皇冠很沉：戴冠的人更难被撞飞
    for (const p of room.list()) p.massMul = p === h ? 1.6 : 1;
    h.score += dt;
    h.stats.crown += dt;
    if (h.score >= room.settings.target) {
      h.score = room.settings.target;
      room.endMatch([h.id]);
    }
  },
  drop(room, x, y) {
    room.m.crown = { holder: null, x, y, wait: 1, guard: 0 };
    for (const p of room.list()) p.massMul = 1;
  },
  onCollide(room, a, b, rel) {
    const cr = room.m.crown;
    if (!cr || !cr.holder || cr.guard > 0 || rel < 280 || a.kind !== 'player' || b.kind !== 'player') return;
    const taker = cr.holder === a.id ? b : cr.holder === b.id ? a : null;
    if (!taker) return;
    const from = cr.holder;
    cr.holder = taker.id;
    cr.guard = CROWN_GUARD;
    room.event({ type: 'crown', id: taker.id, from });
  },
  onPlayerFall(room, p) {
    if (room.m.crown && room.m.crown.holder === p.id) {
      // 皇冠掉在落水点附近靠内侧的安全地砖上
      const tiles = room.map.layout.tiles;
      const tx = p.x * 0.7;
      const ty = p.y * 0.7;
      let best = null;
      let bd = Infinity;
      for (let i = 0; i < tiles.length; i++) {
        if (room.tileState[i] !== 0) continue;
        if ((room.map.bumpers || []).some((b) => Math.hypot(b.x - tiles[i].cx, b.y - tiles[i].cy) < b.r + 30)) continue;
        const d = Math.hypot(tiles[i].cx - tx, tiles[i].cy - ty);
        if (d < bd) {
          bd = d;
          best = tiles[i];
        }
      }
      crown.drop(room, best ? best.cx : 0, best ? best.cy : 0);
      room.event({ type: 'crownDrop', id: p.id });
    }
  },
  onLeave(room, p) {
    if (room.m.crown && room.m.crown.holder === p.id) crown.drop(room, 0, 0);
  },
  snapshot(room) {
    const cr = room.m.crown;
    return cr ? { crown: cr.holder ? { h: cr.holder } : { x: r1(cr.x), y: r1(cr.y) } } : {};
  },
  botGoal(room, p, ctx) {
    const cr = room.m.crown;
    if (!cr) return null;
    if (cr.holder === p.id) {
      const e = ctx.nearestEnemy;
      if (e && ctx.enemyDist < 220) return { x: p.x + (p.x - e.x) + ctx.refuge.x * 0.5 - p.x * 0.5, y: p.y + (p.y - e.y) + ctx.refuge.y * 0.5 - p.y * 0.5, dash: ctx.enemyDist < 90 };
      return { x: ctx.refuge.x, y: ctx.refuge.y };
    }
    if (cr.holder) {
      const h = room.players.get(cr.holder);
      if (h) return { x: h.x, y: h.y, dash: dist(p, h) < 120 };
    }
    return { x: cr.x, y: cr.y };
  },
};

// ---------------------------------------------------------------------
// 涂色大战：限时，脚下的地砖变成自己的颜色，占地最多的人赢
// ---------------------------------------------------------------------
const paint = {
  id: 'paint',
  targets: [60, 90, 120],
  defaultTarget: 90,
  minPlayers: 1,
  respawn: true,
  respawnDelay: 2,
  hazards: { collapse: false, cracks: 'regen', meteors: true },
  setup(room) {
    room.m.owner = new Int16Array(room.map.layout.tiles.length).fill(-1);
    room.m.slots = room.list().map((p) => p.id);
    room.m.clock = room.settings.target;
  },
  slotOf(room, p) {
    let s = room.m.slots.indexOf(p.id);
    if (s < 0) {
      room.m.slots.push(p.id);
      s = room.m.slots.length - 1;
    }
    return s;
  },
  paintAt(room, p, x, y, r) {
    const tiles = room.map.layout.tiles;
    const slot = paint.slotOf(room, p);
    if (r <= 0) {
      const id = room.tileAt(x, y);
      if (id >= 0 && room.tileState[id] !== 2) room.m.owner[id] = slot;
      return;
    }
    for (let i = 0; i < tiles.length; i++) {
      if (room.tileState[i] !== 2 && Math.hypot(tiles[i].cx - x, tiles[i].cy - y) < r) room.m.owner[i] = slot;
    }
  },
  update(room, dt) {
    // 只有脚踩在地上才涂色：跳过去的地砖不算
    for (const p of alivePlayers(room)) if (!airborne(p)) paint.paintAt(room, p, p.x, p.y, p.fx.big > 0 ? 70 : 0);
    // 统计每人的地盘
    const counts = new Array(room.m.slots.length).fill(0);
    for (let i = 0; i < room.m.owner.length; i++) {
      const o = room.m.owner[i];
      if (o >= 0 && room.tileState[i] !== 2) counts[o]++;
    }
    room.m.slots.forEach((id, s) => {
      const p = room.players.get(id);
      if (p) {
        p.score = counts[s];
        p.stats.tiles = Math.max(p.stats.tiles, counts[s]);
      }
    });
    room.m.clock -= dt;
    if (room.m.clock <= 0) {
      room.m.clock = 0;
      const list = room.list();
      const top = Math.max(...list.map((p) => p.score));
      const leaders = list.filter((p) => p.score === top);
      // 并列第一算平局，谁都不赢：以前 1% 对 1% 两个人都被算成赢家，排行榜各记一胜
      if (leaders.length > 1) room.endMatch([], { text: '平局！' });
      else room.endMatch(leaders.map((p) => p.id));
    }
  },
  onItem(room, p, item) {
    if (item.type === 'bomb') paint.paintAt(room, p, p.x, p.y, 190);
  },
  onTileBreak(room, id) {
    if (room.m.owner) room.m.owner[id] = -1;
  },
  snapshot(room) {
    if (!room.m.owner) return {};
    let s = '';
    for (let i = 0; i < room.m.owner.length; i++) s += room.m.owner[i] < 0 ? '.' : String.fromCharCode(97 + room.m.owner[i]);
    return { paint: s, slots: room.m.slots, clock: r1(room.m.clock) };
  },
  botGoal(room, p, ctx) {
    // 找最近的一块不是自己颜色的地砖；附近有人就顺手撞一下
    if (ctx.nearestEnemy && ctx.enemyDist < 80 && Math.random() < 0.3) return { x: ctx.nearestEnemy.x, y: ctx.nearestEnemy.y, dash: true };
    const slot = paint.slotOf(room, p);
    const tiles = room.map.layout.tiles;
    let best = null;
    let bs = Infinity;
    for (let i = 0; i < tiles.length; i++) {
      if (room.tileState[i] !== 0 || room.m.owner[i] === slot) continue;
      const d = Math.hypot(tiles[i].cx - p.x, tiles[i].cy - p.y) + (room.m.owner[i] >= 0 ? -40 : 0) + Math.random() * 30;
      if (d < bs) {
        bs = d;
        best = tiles[i];
      }
    }
    return best ? { x: best.cx, y: best.cy } : null;
  },
};

// ---------------------------------------------------------------------
// 烫手炸弹：拿着炸弹撞别人就能传出去，引信烧完谁拿着谁出局
// ---------------------------------------------------------------------
const potato = {
  id: 'potato',
  targets: [3, 5, 7],
  defaultTarget: 3,
  minPlayers: 2,
  itemTypes: ['big', 'speed', 'shield', 'freeze', 'ghost', 'tornado', 'banana'],
  hazards: { collapse: true, cracks: 'permanent', meteors: true },
  startRound(room) {
    room.m.holder = null;
    room.m.next = 2;
    room.m.fuse = 0;
    room.m.fuseMax = 1;
    room.m.passCd = 0;
  },
  give(room) {
    const alive = alivePlayers(room);
    if (alive.length < 2) return;
    const p = alive[Math.floor(Math.random() * alive.length)];
    room.m.holder = p.id;
    room.m.fuseMax = room.m.fuse = rand(8, 11) + alive.length * 0.6;
    room.m.passCd = 1;
    room.event({ type: 'potatoGive', id: p.id });
  },
  accelMul: (room, p) => (room.m.holder === p.id ? 1.15 : 1),
  update(room, dt) {
    const m = room.m;
    if (!m.holder) {
      m.next -= dt;
      if (m.next <= 0) potato.give(room);
      return;
    }
    m.passCd -= dt;
    m.fuse -= dt;
    const h = room.players.get(m.holder);
    if (!h || !h.alive) {
      m.holder = null;
      m.next = 1;
      return;
    }
    if (m.fuse > 0) return;
    // 引信烧完：原地爆炸出局，把附近的人炸飞
    room.event({ type: 'potatoBoom', id: h.id, x: h.x, y: h.y });
    h.alive = false;
    h.exploded = true;
    h.z = h.vz = 0; // 在空中爆炸也一样：出局的人不留在半空
    h.stats.falls++;
    room.knock(h.x, h.y, 230, 760, null, null, 300);
    m.holder = null;
    m.next = 1.6;
  },
  onCollide(room, a, b, rel) {
    const m = room.m;
    if (!m.holder || m.passCd > 0 || rel < 30 || a.kind !== 'player' || b.kind !== 'player') return;
    const from = m.holder === a.id ? a : m.holder === b.id ? b : null;
    if (!from) return;
    const to = from === a ? b : a;
    if (to.fx.shield > 0 || to.fx.ghost > 0) return;
    m.holder = to.id;
    m.passCd = 0.6;
    from.stats.passes++;
    room.event({ type: 'potatoPass', id: to.id, from: from.id });
  },
  onPlayerFall(room, p) {
    if (room.m.holder === p.id) {
      room.m.holder = null;
      room.m.next = 1;
    }
  },
  onLeave(room, p) {
    potato.onPlayerFall(room, p);
  },
  check: eliminationCheck,
  matchOver: roundWinners,
  snapshot: (room) => ({ holder: room.m.holder, fuse: r1(Math.max(0, room.m.fuse || 0)), fuseMax: r1(room.m.fuseMax || 1) }),
  botGoal(room, p, ctx) {
    const h = room.m.holder && room.players.get(room.m.holder);
    if (!h) return null;
    if (h === p) {
      const e = ctx.nearestEnemy;
      return e ? { x: e.x, y: e.y, dash: ctx.enemyDist < 130 } : null;
    }
    const d = dist(p, h);
    if (d > 260) return null;
    // 远离拿炸弹的人，同时往安全的地方靠
    return { x: p.x + (p.x - h.x) * 2 + (ctx.refuge.x - p.x) * 0.6, y: p.y + (p.y - h.y) * 2 + (ctx.refuge.y - p.y) * 0.6, dash: d < 90 };
  },
};

// ---------------------------------------------------------------------
// 碰碰足球：红蓝两队把大球撞进对方球门
// ---------------------------------------------------------------------
const BALL_R = 34;
const football = {
  id: 'football',
  targets: [3, 5, 7],
  defaultTarget: 3,
  minPlayers: 2,
  teams: true,
  respawn: true,
  respawnDelay: 1.5,
  roundEndDelay: 2.6,
  hazards: { collapse: false, cracks: 'none', meteors: true },
  setup(room) {
    room.balanceTeams();
  },
  kickoffSpot(room) {
    for (const [x, y] of [[0, 0], [0, 110], [0, -110]]) {
      if ((room.map.bumpers || []).every((b) => Math.hypot(b.x - x, b.y - y) > b.r + BALL_R + 10)) return { x, y };
    }
    return { x: 0, y: 0 };
  },
  spawnBall(room) {
    const k = football.kickoffSpot(room);
    const ball = { kind: 'ball', id: 'ball', x: k.x, y: k.y, vx: 0, vy: 0, r: BALL_R, mass: 1.3, alive: true, falling: 0, fx: emptyFx(), lastTouch: null };
    room.bodies = room.bodies.filter((b) => b.kind !== 'ball');
    room.bodies.push(ball);
    room.m.ball = ball;
    room.m.ballRespawn = 0;
  },
  startRound(room) {
    football.spawnBall(room);
  },
  spawn(room, p, i, list) {
    const mates = list.filter((q) => q.team === p.team);
    const k = mates.indexOf(p);
    const side = p.team === 0 ? -1 : 1;
    const x = side * room.map.goal.x * (0.45 + (k % 2) * 0.2);
    const y = (k - (mates.length - 1) / 2) * 75;
    return { x, y };
  },
  update(room, dt) {
    const m = room.m;
    const ball = m.ball;
    if (!ball || !ball.alive) {
      m.ballRespawn -= dt;
      if (m.ballRespawn <= 0) {
        football.spawnBall(room);
        room.event({ type: 'ballBack' });
      }
      return;
    }
    if (ball.falling) return;
    const g = room.map.goal;
    for (const side of [-1, 1]) {
      if (Math.abs(ball.x - side * g.x) <= g.hw && Math.abs(ball.y) <= g.hh) {
        // 左边球门是红队的，球进左门 = 蓝队得分
        const scorer = side < 0 ? 1 : 0;
        room.teamScore[scorer]++;
        const shooter = ball.lastTouch && room.players.get(ball.lastTouch);
        const own = shooter && shooter.team !== scorer;
        if (shooter && !own) {
          shooter.stats.goals++;
          shooter.score++;
        }
        room.event({ type: 'goal', team: scorer, id: shooter ? shooter.id : null, own: !!own, x: ball.x, y: ball.y });
        const key = shooter ? (own ? '{name} 乌龙球！' : '{name} 进球！') : '进球！';
        room.endRound({ winnerTeam: scorer, key, p: shooter ? { name: shooter.name } : {} });
        return;
      }
    }
  },
  onCollide(room, a, b) {
    const ball = a.kind === 'ball' ? a : b.kind === 'ball' ? b : null;
    const p = a.kind === 'player' ? a : b.kind === 'player' ? b : null;
    if (ball && p) ball.lastTouch = p.id;
  },
  onBodyFall(room, b) {
    if (b.kind !== 'ball') return;
    room.event({ type: 'ballOut', x: b.x, y: b.y });
    room.m.ballRespawn = 1.4;
  },
  matchOver(room) {
    const t = room.teamScore.findIndex((s) => s >= room.settings.target);
    if (t < 0) return null;
    room.winnerTeam = t;
    return { winners: room.list().filter((p) => p.team === t).map((p) => p.id), winnerTeam: t };
  },
  snapshot: (room) => ({ goal: room.map.goal }),
  botGoal(room, p, ctx) {
    const ball = room.m.ball;
    if (!ball || !ball.alive || ball.falling) return { x: 0, y: 0 };
    const g = room.map.goal;
    const atk = p.team === 0 ? 1 : -1; // 进攻方向
    const own = { x: -atk * g.x, y: 0 };
    const mates = room.list().filter((q) => q.team === p.team && q.alive);
    const keeper = mates.length > 1 && mates.sort((a, b) => atk * (a.x - b.x))[0] === p;
    // 守门员：球在我方半场时站在球和球门之间
    if (keeper && ball.x * atk < 0) return { x: own.x + (ball.x - own.x) * 0.35, y: own.y + (ball.y - own.y) * 0.35 };
    const gx = atk * g.x - ball.x;
    const gy = -ball.y;
    const gl = Math.hypot(gx, gy) || 1;
    const ux = gx / gl;
    const uy = gy / gl;
    const off = BALL_R + PLAYER_R + 14;
    const bx = ball.x - ux * off;
    const by = ball.y - uy * off;
    const tx = ball.x - p.x;
    const ty = ball.y - p.y;
    const tl = Math.hypot(tx, ty) || 1;
    const aligned = (tx * ux + ty * uy) / tl > 0.75;
    if (aligned) return { x: ball.x + ux * 20, y: ball.y + uy * 20, dash: tl < 150 };
    // 绕到球后面：先侧移再靠近，避免把球往自己门里推
    const side = Math.sign((p.x - ball.x) * -uy + (p.y - ball.y) * ux) || 1;
    return { x: bx + -uy * side * 50, y: by + ux * side * 50 };
  },
  ballSafe: true,
};

// King of the hill: the team alone inside the center ring earns control time.
const hill = {
  id: 'hill',
  targets: [20, 30, 45],
  defaultTarget: 30,
  minPlayers: 2,
  teams: true,
  respawn: true,
  respawnDelay: 1.5,
  hazards: { collapse: false, cracks: 'regen', meteors: true },
  setup(room) {
    room.m.zoneOwner = -1;
    room.m.zoneCounts = [0, 0];
  },
  update(room, dt) {
    const counts = [0, 0];
    for (const p of alivePlayers(room)) {
      if (p.fx.ghost > 0 || airborne(p) || Math.hypot(p.x, p.y) > 112) continue;
      counts[p.team]++;
    }
    const owner = counts[0] === counts[1] ? -1 : counts[0] > counts[1] ? 0 : 1;
    room.m.zoneOwner = owner;
    room.m.zoneCounts = counts;
    if (owner < 0) return;
    room.teamScore[owner] += dt;
    const present = alivePlayers(room).filter((p) => p.team === owner && p.fx.ghost <= 0 && !airborne(p) && Math.hypot(p.x, p.y) <= 112);
    for (const p of present) p.score += dt / present.length;
  },
  check(room) {
    const team = room.teamScore.findIndex((score) => score >= room.settings.target);
    if (team < 0) return;
    const winners = room.list().filter((p) => p.team === team).map((p) => p.id);
    room.endMatch(winners, { winnerTeam: team });
  },
  snapshot(room) {
    return { zoneOwner: room.m.zoneOwner, zoneCounts: room.m.zoneCounts };
  },
  botGoal(room, p, ctx) {
    const counts = room.m.zoneCounts || [0, 0];
    const enemy = ctx.nearestEnemy;
    if (counts[0] && counts[1] && enemy && Math.hypot(enemy.x, enemy.y) < 145) {
      return { x: enemy.x, y: enemy.y, dash: ctx.enemyDist < 170 };
    }
    return { x: 0, y: 0, dash: Math.hypot(p.x, p.y) > 180 && (!ctx.nearestEnemy || ctx.enemyDist < 130) };
  },
};

// Solo hill: the closest grounded player inside the center ring earns control time.
const soloHill = {
  id: 'soloHill',
  targets: [15, 20, 30],
  defaultTarget: 20,
  minPlayers: 2,
  respawn: true,
  respawnDelay: 1.5,
  hazards: { collapse: false, cracks: 'regen', meteors: true },
  setup(room) {
    room.m.zonePlayer = null;
  },
  update(room, dt) {
    const candidates = alivePlayers(room).filter((p) => p.fx.ghost <= 0 && !airborne(p) && Math.hypot(p.x, p.y) <= 112);
    const owner = candidates.reduce((best, p) => !best || Math.hypot(p.x, p.y) < Math.hypot(best.x, best.y) ? p : best, null);
    room.m.zonePlayer = owner ? owner.id : null;
    if (owner) owner.score += dt;
  },
  check(room) {
    const winner = room.list().find((p) => p.score >= room.settings.target);
    if (winner) room.endMatch([winner.id]);
  },
  snapshot(room) {
    return { zonePlayer: room.m.zonePlayer };
  },
  botGoal(room, p, ctx) {
    const owner = room.players.get(room.m.zonePlayer);
    if (owner && owner.id !== p.id && dist(p, owner) < 220) return { x: owner.x, y: owner.y, dash: dist(p, owner) < 150 };
    return { x: 0, y: 0, dash: Math.hypot(p.x, p.y) > 180 && (!ctx.nearestEnemy || ctx.enemyDist < 130) };
  },
};

// ---------------------------------------------------------------------
// 合力打 Boss（多人协作 1~8 人）：把巨无霸推下场地若干次，共享复活次数
// ---------------------------------------------------------------------
const DIFF = {
  1: { lives: [6, 2], bossLives: 3, mass: 0.8, accel: 560, cd: 3.8, slam: 550, charge: 750, tired: 1.7, name: '简单' },
  2: { lives: [5, 1.5], bossLives: 3, mass: 0.95, accel: 650, cd: 3.2, slam: 650, charge: 850, tired: 1.3, name: '普通' },
  3: { lives: [4, 1], bossLives: 4, mass: 1.1, accel: 740, cd: 2.6, slam: 750, charge: 950, tired: 1, name: '困难' },
};
const BOSS_ENRAGE = 120;
const BOSS_SLAM_DODGE_Z = 10;
const BOSS_SKILL_CD = 3.5;
// 砸地的节奏（客户端 public/js/render/bossanim.js 按同样的数字播动画，改了要一起改）：
// 蓄力 1.3 秒跳到空中 → 砸下来前 0.45 秒在空中停住、闪白光、发出呼啸声（"现在跳"）→ 最后 0.3 秒砸下来，落地那一刻冲击波
const BOSS_SLAM_WIND = 1.3;
const BOSS_SLAM_TELL = 0.45;
// 宽限：冲击波落地后 0.15 秒内离开地面的人也算躲开。画面有插值延迟、按键传到服务器也要时间，
// 看着它落地那一刻才按跳的人，按键到服务器时已经晚了一点点——不给宽限的话会觉得"明明跳了还被砸"
const BOSS_SLAM_GRACE = 0.15;
const boss = {
  id: 'boss',
  targets: [1, 2, 3],
  defaultTarget: 2,
  minPlayers: 1,
  coop: true,
  respawn: true,
  respawnDelay: 2.5,
  hazards: { collapse: false, cracks: 'regen', meteors: true },
  setup(room) {
    const n = Math.max(1, room.list().length);
    const d = DIFF[room.settings.target] || DIFF[2];
    for (const p of room.list()) p.team = 0;
    room.m.diff = d;
    room.m.n = n;
    room.m.livesMax = room.m.lives = Math.round(d.lives[0] + n * d.lives[1]);
    room.m.bossLivesMax = room.m.bossLives = d.bossLives;
    room.m.phase = 1;
    room.m.bossRespawn = 0;
    room.m.minionT = 8;
  },
  startRound(room) {
    room.m.slam = null;
    boss.spawnBoss(room, 0);
  },
  spawn(room, p, i, list) {
    const a = (i / list.length) * Math.PI * 2 + Math.PI / 2;
    const r = Math.min(270, room.map.layout.radius * 0.58);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  },
  spawnBoss(room, inv) {
    const m = room.m;
    const d = m.diff;
    const t = room.tileAt(0, 0) >= 0 && room.tileState[room.tileAt(0, 0)] === 0 ? { cx: 0, cy: 0 } : room.safeSpot(false) || { cx: 0, cy: 0 };
    const bumperAtCenter = (room.map.bumpers || []).find((b) => Math.hypot(b.x - t.cx, b.y - t.cy) < b.r + 70);
    const pos = bumperAtCenter ? { cx: 0, cy: -150 } : t;
    const b = {
      kind: 'boss',
      id: 'boss',
      x: pos.cx,
      y: pos.cy,
      vx: 0,
      vy: 0,
      r: 60,
      mass: (4 + m.n * 0.9) * d.mass,
      damping: 3.4, // 比玩家更"稳"，被推一下不会一路滑出场
      accel: d.accel * (1 + (m.phase - 1) * 0.12) * (m.enraged ? 1.3 : 1),
      alive: true,
      falling: 0,
      fx: emptyFx(),
      input: { x: 0, y: 0 },
      state: 'chase',
      stateT: 2.5,
      dir: { x: 0, y: 1 },
      target: null,
      lastHitBy: null,
      lastHitTime: -99,
    };
    b.fx.ghost = inv;
    room.bodies = room.bodies.filter((x) => x.kind !== 'boss');
    room.bodies.push(b);
    m.boss = b;
  },
  spawnMinion(room) {
    const t = room.safeSpot(true);
    if (!t) return;
    room.bodies.push({ kind: 'minion', id: 'm' + room.nextObj++, x: t.cx, y: t.cy, vx: 0, vy: 0, r: 18, mass: 0.8, accel: 950, alive: true, falling: 0, fx: emptyFx(), input: { x: 0, y: 0 }, think: 0, lastHitBy: null, lastHitTime: -99 });
    room.event({ type: 'minion', x: t.cx, y: t.cy });
  },
  control(room, b, dt) {
    const players = alivePlayers(room).filter((p) => p.fx.ghost <= 0);
    if (b.kind === 'minion') {
      b.think -= dt;
      if (b.think <= 0) {
        b.think = 0.2;
        let t = null;
        let td = Infinity;
        for (const p of players) {
          const d = dist(p, b);
          if (d < td) {
            td = d;
            t = p;
          }
        }
        const dx = t ? t.x - b.x : -b.x;
        const dy = t ? t.y - b.y : -b.y;
        const l = Math.hypot(dx, dy) || 1;
        b.input.x = dx / l;
        b.input.y = dy / l;
        if (t && td < 100 && Math.random() < 0.25) {
          b.vx += (dx / l) * 520;
          b.vy += (dy / l) * 520;
        }
      }
      return;
    }
    const m = room.m;
    b.stateT -= dt;
    if (b.fx.frozen > 0 || b.fx.slip > 0) return;
    if (!b.target || !b.target.alive || Math.random() < dt * 0.4) {
      let t = null;
      let td = Infinity;
      for (const p of players) {
        const d = dist(p, b) + Math.random() * 120;
        if (d < td) {
          td = d;
          t = p;
        }
      }
      b.target = t;
    }
    const t = b.target;
    switch (b.state) {
      case 'chase': {
        if (t) {
          const dx = t.x - b.x;
          const dy = t.y - b.y;
          const l = Math.hypot(dx, dy) || 1;
          b.input.x = dx / l;
          b.input.y = dy / l;
        } else {
          b.input.x = -b.x / 300;
          b.input.y = -b.y / 300;
        }
        // 别自己走到边上：前方没地面就往中心拐
        const ax = b.x + b.input.x * (b.r + 40);
        const ay = b.y + b.input.y * (b.r + 40);
        if (!room.safeAt(ax, ay)) {
          const l = Math.hypot(b.x, b.y) || 1;
          b.input.x = -b.x / l;
          b.input.y = -b.y / l;
        }
        if (b.stateT <= 0 && t) {
          const d = dist(t, b);
          if (d < 420 && Math.random() < 0.6) {
            b.state = 'windup';
            b.stateT = 1;
            const l = d || 1;
            b.dir = { x: (t.x - b.x) / l, y: (t.y - b.y) / l };
            room.event({ type: 'bossWindup' });
          } else {
            b.state = 'slamWind';
            b.stateT = BOSS_SLAM_WIND;
            b.told = false;
            b.slams = (b.slams || 0) + 1; // 第几次砸地（机器人用来判断这次躲过没有）
            room.event({ type: 'bossSlamWind', x: b.x, y: b.y });
          }
        }
        break;
      }
      case 'windup':
        b.input.x = b.input.y = 0;
        if (t) {
          const dx = t.x - b.x;
          const dy = t.y - b.y;
          const l = Math.hypot(dx, dy) || 1;
          b.dir = { x: b.dir.x * 0.9 + (dx / l) * 0.1, y: b.dir.y * 0.9 + (dy / l) * 0.1 };
        }
        if (b.stateT <= 0) {
          const power = m.diff.charge * (1 + (m.phase - 1) * 0.1);
          b.vx += b.dir.x * power;
          b.vy += b.dir.y * power;
          b.state = 'charge';
          b.stateT = 0.7;
          room.event({ type: 'bossCharge' });
        }
        break;
      case 'charge':
        b.input.x = b.input.y = 0;
        if (b.stateT <= 0) boss.tire(room, b, 1);
        break;
      case 'slamWind':
        b.input.x = b.input.y = 0;
        if (!b.told && b.stateT <= BOSS_SLAM_TELL) {
          b.told = true;
          room.event({ type: 'bossSlamSoon', x: r1(b.x), y: r1(b.y) });
        }
        if (b.stateT <= 0) {
          room.event({ type: 'bossSlam', x: b.x, y: b.y, r: 230 });
          // 砸地是沿着地面的冲击波：那一刻跳在空中（离地超过 10）的人不受影响。
          // 站在地上的人先记下来，宽限 0.15 秒内起跳的也算躲开，其余的人宽限结束时被震飞（boss.update 里）
          const ids = new Set();
          for (const p of alivePlayers(room)) if (!(p.z > BOSS_SLAM_DODGE_Z) && p.fx.ghost <= 0 && dist(p, b) <= 230 + 60) ids.add(p.id);
          m.slam = { x: b.x, y: b.y, t: BOSS_SLAM_GRACE, ids, power: m.diff.slam, boss: b };
          boss.tire(room, b, 0.8);
        }
        break;
      case 'tired':
        // 放完大招累趴了：不能动、变轻、被撞会滑很远 —— 全员进攻的好机会
        b.input.x = b.input.y = 0;
        if (b.stateT <= 0) {
          b.state = 'chase';
          b.massMul = 1;
          b.damping = 3.4;
          b.stateT = m.diff.cd * (1 - (m.phase - 1) * 0.15) * rand(0.8, 1.3) * (m.enraged ? 0.6 : 1);
        }
        break;
    }
  },
  tire(room, b, k) {
    b.state = 'tired';
    b.stateT = room.m.diff.tired * k * (1 - (room.m.phase - 1) * 0.1);
    b.massMul = 0.75;
    b.damping = 3;
    room.event({ type: 'bossTired', x: b.x, y: b.y });
  },
  skill(room, p, face) {
    if (p.skillCd > 0) return;
    const bossBody = room.m.boss;
    let dx = face.x;
    let dy = face.y;
    let len = Math.hypot(dx, dy);
    if (len < 0.1) {
      dx = p.input.x;
      dy = p.input.y;
      len = Math.hypot(dx, dy);
    }
    if (len < 0.1 && bossBody) {
      dx = bossBody.x - p.x;
      dy = bossBody.y - p.y;
      len = Math.hypot(dx, dy);
    }
    if (len < 0.1) return;
    dx /= len;
    dy /= len;
    p.skillCd = BOSS_SKILL_CD;
    let hit = false;
    for (const enemy of room.bodies) {
      if (!enemy.alive || enemy.falling || enemy.fx.ghost > 0 || !['boss', 'minion'].includes(enemy.kind)) continue;
      const ox = enemy.x - p.x;
      const oy = enemy.y - p.y;
      const forward = ox * dx + oy * dy;
      const side = Math.abs(ox * dy - oy * dx);
      if (forward < 0 || forward > 300 + enemy.r || side > enemy.r + 24) continue;
      const tired = enemy.kind === 'boss' && enemy.state === 'tired';
      const impulse = (enemy.kind === 'boss' ? (tired ? 2600 : 1650) : 850) / Math.max(1, enemy.mass * (enemy.massMul || 1));
      enemy.vx += dx * impulse;
      enemy.vy += dy * impulse;
      room.hitBy(enemy, p);
      if (enemy.kind === 'boss') {
        p.stats.dmg += impulse;
        room.event({ type: 'bossHit', id: p.id, x: enemy.x, y: enemy.y, power: Math.round(impulse), skill: true });
      }
      hit = true;
    }
    room.event({ type: 'bossSkill', id: p.id, x: r1(p.x), y: r1(p.y), dx: r1(dx), dy: r1(dy), hit });
  },
  update(room, dt) {
    const m = room.m;
    // 砸地的宽限时间：这期间离开地面（起跳）的人躲开了；时间到了还站在地上、还在范围里的人被震飞
    const slam = m.slam;
    if (slam) {
      for (const id of slam.ids) {
        const p = room.players.get(id);
        if (!p || !p.alive || p.falling || airborne(p)) slam.ids.delete(id);
      }
      slam.t -= dt;
      if (slam.t <= 0) {
        m.slam = null;
        if (slam.ids.size) room.knock(slam.x, slam.y, 230, slam.power, slam.boss, (o) => slam.ids.has(o.id), 220);
      }
    }
    // 打太久 Boss 会狂暴：更快、出招更频繁，保证比赛不会无限拖下去
    if (!m.enraged && room.roundTime > BOSS_ENRAGE) {
      m.enraged = true;
      m.shrinkT = 4;
      m.shrinkLayer = 0;
      if (m.boss) m.boss.accel *= 1.3;
      room.event({ type: 'bossEnrage' });
    }
    // 狂暴后场地从外圈开始一层层永久坍塌，至少留两层
    if (m.enraged && m.shrinkLayer < room.map.layout.layers - 2) {
      m.shrinkT -= dt;
      if (m.shrinkT <= 0) {
        m.shrinkT = 14;
        const tiles = room.map.layout.tiles;
        for (let i = 0; i < tiles.length; i++) if (tiles[i].layer === m.shrinkLayer) room.warnTile(i, 3);
        m.shrinkLayer++;
        room.event({ type: 'collapse' });
      }
    }
    if (!m.boss) {
      m.bossRespawn -= dt;
      if (m.bossRespawn <= 0) {
        boss.spawnBoss(room, 2);
        room.event({ type: 'bossBack', phase: m.phase });
      }
    }
    if (m.phase >= 2) {
      m.minionT -= dt;
      const count = room.bodies.filter((b) => b.kind === 'minion').length;
      if (m.minionT <= 0) {
        m.minionT = m.phase >= 3 ? 7 : 10;
        const want = m.phase >= 3 ? 3 : 2;
        for (let i = count; i < want; i++) boss.spawnMinion(room);
      }
    }
    for (const p of room.list()) p.score = Math.round(p.stats.dmg / 100) + p.stats.finishers * 5;
  },
  onCollide(room, a, b, rel) {
    const enemy = a.kind === 'boss' || a.kind === 'minion' ? a : b.kind === 'boss' || b.kind === 'minion' ? b : null;
    const p = a.kind === 'player' ? a : b.kind === 'player' ? b : null;
    if (!enemy || !p || rel < 60) return;
    enemy.lastHitBy = p.id;
    enemy.lastHitTime = room.roundTime;
    if (enemy.kind === 'boss') {
      p.stats.dmg += rel;
      if (rel > 220) room.event({ type: 'bossHit', id: p.id, x: enemy.x, y: enemy.y, power: Math.round(rel) });
    }
  },
  onBodyFall(room, b) {
    const m = room.m;
    const finisher = b.lastHitBy && room.roundTime - b.lastHitTime < 5 ? room.players.get(b.lastHitBy) : null;
    if (b.kind === 'minion') {
      if (finisher) finisher.stats.kills++;
      room.event({ type: 'minionDown', id: finisher ? finisher.id : null, x: b.x, y: b.y });
      return;
    }
    if (b.kind !== 'boss') return;
    m.bossLives--;
    if (finisher) {
      finisher.stats.finishers++;
      finisher.kills++;
    }
    room.event({ type: 'bossDown', id: finisher ? finisher.id : null, lives: m.bossLives, x: b.x, y: b.y });
    m.boss = null;
    if (m.bossLives <= 0) {
      room.endMatch(room.list().map((p) => p.id), { coop: { win: true }, text: '成功击败巨无霸！' });
      return;
    }
    m.phase = Math.min(3, m.bossLivesMax - m.bossLives + 1);
    m.bossRespawn = 3;
    m.minionT = 2;
  },
  keepBroken: (room, id) => !!room.m.enraged && room.map.layout.tiles[id].layer < room.m.shrinkLayer,
  onPlayerFall(room, p) {
    if (room.m.lives > 0) {
      room.m.lives--;
    } else {
      p.out = true;
    }
  },
  canRespawn: (room, p) => !p.out,
  check(room) {
    const list = room.list();
    const anyoneLeft = list.some((p) => (p.alive && !p.falling) || (!p.out && p.respawn > 0) || p.falling > 0);
    if (!anyoneLeft && list.length) room.endMatch([], { coop: { win: false }, text: '全员阵亡……' });
  },
  snapshot(room) {
    const m = room.m;
    const b = m.boss;
    return {
      lives: m.lives,
      livesMax: m.livesMax,
      bossLives: m.bossLives,
      bossLivesMax: m.bossLivesMax,
      phase: m.phase,
      diff: m.diff ? m.diff.name : '',
      bossState: b ? b.state : null,
      // 离砸下来还有几秒：客户端按这个播"跳起 → 停住 → 砸下"，保证画面上落地的那一刻就是冲击波的那一刻
      bossT: b && b.state === 'slamWind' ? Math.max(0, Math.round(b.stateT * 1000) / 1000) : null,
      enraged: !!m.enraged,
      bossDir: b ? { x: r1(b.dir.x), y: r1(b.dir.y) } : null,
    };
  },
  botGoal(room, p, ctx) {
    const b = room.m.boss;
    if (!b || !b.alive || b.falling) return { x: ctx.refuge.x, y: ctx.refuge.y };
    const d = dist(p, b);
    // 躲技能：蓄力冲撞时闪到侧面，砸地前跑出范围
    if (b.state === 'slamWind' && d < 290) return { x: p.x + (p.x - b.x), y: p.y + (p.y - b.y), dash: d < 200 };
    if (b.state === 'windup' && d < 450) {
      const side = Math.sign((p.x - b.x) * -b.dir.y + (p.y - b.y) * b.dir.x) || 1;
      return { x: p.x - b.dir.y * side * 100, y: p.y + b.dir.x * side * 100, dash: d < 260 };
    }
    // 从靠近中心的一侧撞过去，把 Boss 往外推；它累趴的时候全力冲
    const ox = b.x - ctx.refuge.x;
    const oy = b.y - ctx.refuge.y;
    const ol = Math.hypot(ox, oy) || 1;
    const aim = { x: b.x - (ox / ol) * (b.r + 20), y: b.y - (oy / ol) * (b.r + 20) };
    const ad = Math.hypot(aim.x - p.x, aim.y - p.y);
    if (ad < (b.state === 'tired' ? 130 : 50)) return { x: b.x, y: b.y, dash: true };
    return { x: aim.x, y: aim.y };
  },
};

// ---------------------------------------------------------------------
// 绳索闯关（协作 1-8 人）：全队按 1-2-3-…顺序用绳子串成一串。
// 每关要拿钥匙开锁放下吊桥、同时踩住压力板、踩着闪烁地砖过河，全员站进出口才算过关。
// 有人踩空时，只要绳子另一头的队友站稳了，就会被吊在边上慢慢拉回来。
// ---------------------------------------------------------------------
const ROPE_LEN = 150; // 相邻两人之间绳子的最大长度
const ROPE_DIFF = {
  1: { lives: [8, 2], blink: 3.2, soloHold: 5, hangMax: 6, name: '简单' },
  2: { lives: [5, 1], blink: 2.6, soloHold: 4, hangMax: 4.5, name: '普通' },
  3: { lives: [3, 0.5], blink: 2.1, soloHold: 3, hangMax: 3, name: '困难' },
};
const tileCenter = (room, id) => {
  const t = room.map.layout.tiles[id];
  return { x: t.cx, y: t.cy };
};

const rope = {
  id: 'rope',
  targets: [1, 2, 3],
  defaultTarget: 2,
  minPlayers: 1,
  coop: true,
  respawn: true,
  respawnDelay: 2.5,
  roundEndDelay: 3,
  noItems: true,
  ropeLen: ROPE_LEN,
  // 空中水平速度上限：能跳过闪烁地砖的空隙（2 格），但冲刺 + 跳也飞不过 6 格宽的断桥（钥匙 / 机关必须做）
  airSpeedCap: 480,
  hazards: { collapse: false, cracks: 'none', meteors: false },
  keepBroken: () => true, // 桥和闪烁地砖只由模式控制，不会自己长回来
  chain: (room) => room.list().filter((p) => p.alive && !p.falling && !p.out),
  setup(room) {
    const n = Math.max(1, room.list().length);
    const d = ROPE_DIFF[room.settings.target] || ROPE_DIFF[2];
    for (const p of room.list()) p.team = 0;
    room.m.diff = d;
    room.m.livesMax = room.m.lives = Math.round(d.lives[0] + n * d.lives[1]);
    room.m.stage = 0;
    room.m.stageTimes = [];
  },
  beforeRound(room) {
    room.m.stage = Math.min(room.round, STAGES.length - 1);
    room.m.level = getLevel(room.m.stage, room.settings.map);
  },
  startRound(room) {
    const m = room.m;
    const f = m.level.feat;
    for (const id of [...f.kBridge, ...f.pBridge, ...f.blinkB]) {
      room.tileState[id] = 2;
      room.tileTimer[id] = Infinity;
    }
    m.key = f.key ? { x: f.key.x, y: f.key.y, holder: null, done: false } : null;
    m.plates = f.plates.map((p) => ({ x: p.x, y: p.y, t: 0, on: false }));
    m.kOpen = !f.key;
    m.pOpen = !f.plates.length;
    m.blink = f.blinkA.length ? { phase: 0, t: m.diff.blink } : null;
    m.stageStart = room.matchTime;
    m.inExit = 0;
    m.need = room.list().filter((p) => !p.out).length;
    m.exitSet = new Set(f.exit);
    m.exitAt = f.exitCore.reduce((a, id) => {
      const c = tileCenter(room, id);
      return { x: a.x + c.x / f.exitCore.length, y: a.y + c.y / f.exitCore.length };
    }, { x: 0, y: 0 });
  },
  // 出生点：按蛇形顺序排，保证 1 挨着 2、2 挨着 3……
  spawn(room, p, i) {
    const tiles = room.map.layout.tiles;
    const ids = [...room.m.level.feat.spawns].sort((a, b) => tiles[a].gj - tiles[b].gj || (tiles[a].gj % 2 ? tiles[b].gi - tiles[a].gi : tiles[a].gi - tiles[b].gi));
    const slots = [];
    for (const id of ids) for (const s of [-1, 1]) slots.push({ x: tiles[id].cx + s * 17, y: tiles[id].cy });
    return slots[i % slots.length];
  },
  // 绳子：相邻两人超过长度就互相拉；踩空的人被吊住
  constrain(room, active, dt, playing) {
    const m = room.m;
    const chain = rope.chain(room);
    if (chain.length < 2) {
      for (const p of chain) p.hanging = false;
      return;
    }
    const inv = (p) => (p.hanging ? 4 : 1) / massOf(p);
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i];
        const b = chain[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d <= ROPE_LEN || d === 0) continue;
        const nx = dx / d;
        const ny = dy / d;
        const wa = inv(a);
        const wb = inv(b);
        const sa = wa / (wa + wb);
        const sb = wb / (wa + wb);
        const ex = d - ROPE_LEN;
        a.x += nx * ex * sa;
        a.y += ny * ex * sa;
        b.x -= nx * ex * sb;
        b.y -= ny * ex * sb;
        const vr = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vr < 0) {
          a.vx += nx * vr * sa;
          a.vy += ny * vr * sa;
          b.vx -= nx * vr * sb;
          b.vy -= ny * vr * sb;
        }
      }
    }
    if (!playing) return;
    const grounded = chain.map((p) => room.supported(p.x, p.y));
    const load = new Map();
    chain.forEach((p, i) => {
      // 正跳过缺口、或者刚走出边缘还在土狼时间里（还能起跳）：先不算踩空
      if (!grounded[i] && !p.hanging && (airborne(p) || p.coyote > 0)) return;
      if (grounded[i]) {
        if (p.hanging) {
          // 被队友拉回地面了
          p.hanging = false;
          const by = room.players.get(p.anchor);
          if (by && by !== p) by.stats.saves++;
          room.event({ type: 'saved', id: p.id, by: by ? by.id : null });
        }
        p.hangT = 0;
        return;
      }
      // 只有直接相邻、而且站稳了的队友才拉得住你
      const nb = [i - 1, i + 1].filter((k) => k >= 0 && k < chain.length && grounded[k] && dist(chain[k], p) <= ROPE_LEN + 20).map((k) => chain[k]);
      if (!nb.length || (p.hanging && p.hangT > m.diff.hangMax)) {
        if (p.hanging) room.event({ type: 'ropeSlip', id: p.id });
        p.hanging = false;
        p.hangT = -99; // 这次掉下去，不再抓住
        return;
      }
      if (p.hangT < 0) return;
      const a = nb.reduce((x, y) => (dist(x, p) <= dist(y, p) ? x : y));
      if (!p.hanging) {
        p.hanging = true;
        p.hangT = 0;
        p.anchor = a.id;
        room.event({ type: 'hang', id: p.id, by: a.id });
      }
      p.hangT += dt;
      // 慢慢往队友那边拉
      const dx = a.x - p.x;
      const dy = a.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      const damp = Math.max(0, 1 - 5 * dt);
      p.vx = p.vx * damp + (dx / d) * 520 * dt;
      p.vy = p.vy * damp + (dy / d) * 520 * dt;
      load.set(a, (load.get(a) || []).concat(p));
    });
    // 一个人拉两个就拉不住了，会被一起往外拖
    for (const [a, hangers] of load) {
      const k = hangers.length >= 2 ? 700 : 110;
      for (const h of hangers) {
        const dx = h.x - a.x;
        const dy = h.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        a.vx += (dx / d) * k * dt;
        a.vy += (dy / d) * k * dt;
      }
    }
  },
  update(room, dt) {
    const m = room.m;
    const f = m.level.feat;
    const standing = rope.chain(room).filter((p) => !p.hanging);
    // 钥匙：碰到就拿起来，送到锁上放下吊桥；拿钥匙的人掉下去钥匙会回到原处
    if (m.key && !m.key.done) {
      const k = m.key;
      let h = k.holder ? room.players.get(k.holder) : null;
      if (k.holder && (!h || !h.alive || h.falling || h.out)) {
        h = null;
        k.holder = null;
        k.x = f.key.x;
        k.y = f.key.y;
        room.event({ type: 'keyReset' });
      }
      if (!h) {
        const p = standing.find((q) => !airborne(q) && Math.hypot(q.x - k.x, q.y - k.y) < 42);
        if (p) {
          h = p;
          k.holder = p.id;
          room.event({ type: 'keyPick', id: p.id });
        }
      }
      if (h) {
        k.x = h.x;
        k.y = h.y;
        if (!h.hanging && !airborne(h) && Math.hypot(h.x - f.lock.x, h.y - f.lock.y) < 48) {
          k.done = true;
          k.holder = null;
          k.x = f.lock.x;
          k.y = f.lock.y;
          m.kOpen = true;
          h.stats.keys++;
          for (const id of f.kBridge) room.tileState[id] = 0;
          room.event({ type: 'unlock', id: h.id, x: f.lock.x, y: f.lock.y });
        }
      }
    }
    // 压力板：全部同时亮起才打开机关桥（一个人玩时踩过的板会亮一会儿）
    if (!m.pOpen && m.plates.length) {
      const hold = rope.chain(room).length <= 1 ? m.diff.soloHold : 0.35;
      m.plates.forEach((pl, i) => {
        // 压力板要站上去踩住：跳在空中不算
        const p = standing.find((q) => !airborne(q) && Math.hypot(q.x - pl.x, q.y - pl.y) < 38);
        if (p) {
          if (pl.t <= 0) {
            p.stats.plates++;
            room.event({ type: 'plate', i, id: p.id, x: pl.x, y: pl.y });
          }
          pl.t = hold;
        } else pl.t = Math.max(0, pl.t - dt);
        pl.on = pl.t > 0;
      });
      if (m.plates.every((pl) => pl.on)) {
        m.pOpen = true;
        for (const id of f.pBridge) room.tileState[id] = 0;
        const c = f.pBridge.length ? tileCenter(room, f.pBridge[Math.floor(f.pBridge.length / 2)]) : m.plates[0];
        room.event({ type: 'platesOpen', x: c.x, y: c.y });
      }
    }
    for (const p of room.list()) p.score = p.stats.keys * 5 + p.stats.plates * 2 + p.stats.saves * 3;
    // 闪烁地砖：新的一组先出现，旧的一组过 0.7 秒再消失
    if (m.blink) {
      const b = m.blink;
      b.t -= dt;
      if (b.t <= 0) {
        const show = b.phase === 0 ? f.blinkB : f.blinkA;
        const hide = b.phase === 0 ? f.blinkA : f.blinkB;
        b.phase = 1 - b.phase;
        b.t = m.diff.blink;
        for (const id of show) room.tileState[id] = 0;
        for (const id of hide) room.warnTile(id, 0.7);
        room.event({ type: 'blink' });
      }
    }
  },
  onPlayerFall(room, p) {
    if (room.m.lives > 0) room.m.lives--;
    else p.out = true;
  },
  canRespawn: (room, p) => !p.out,
  // 复活在链子上相邻的队友旁边，不会被甩到很远的地方
  respawnPos(room, p) {
    const list = room.list();
    const idx = list.indexOf(p);
    const ok = (q) => q && q !== p && q.alive && !q.falling && !q.hanging && room.safeAt(q.x, q.y);
    let near = null;
    for (let d = 1; d < list.length && !near; d++) near = [list[idx - d], list[idx + d]].find(ok) || null;
    const tiles = room.map.layout.tiles;
    const blink = new Set([...room.m.level.feat.blinkA, ...room.m.level.feat.blinkB]);
    const bodies = room.activeBodies();
    const from = near || tileCenter(room, room.m.level.feat.spawns[0]);
    let best = null;
    let bd = Infinity;
    tiles.forEach((t, i) => {
      if (room.tileState[i] !== 0 || blink.has(i)) return;
      const d = Math.hypot(t.cx - from.x, t.cy - from.y);
      if (d > 260 || d >= bd) return;
      if (bodies.some((b) => Math.hypot(b.x - t.cx, b.y - t.cy) < 40)) return;
      if ((room.map.bumpers || []).some((b) => Math.hypot(b.x - t.cx, b.y - t.cy) < b.r + 30)) return;
      best = t;
      bd = d;
    });
    return best ? { x: best.cx, y: best.cy } : null;
  },
  check(room) {
    const m = room.m;
    const list = room.list();
    const need = list.filter((p) => !p.out);
    if (!need.length || !list.some((p) => (p.alive && !p.falling) || p.falling > 0 || (!p.out && p.respawn > 0))) {
      room.endMatch([], { coop: { win: false, stage: m.stage }, text: '绳子断光了……' });
      return;
    }
    const inside = (p) => p.alive && !p.falling && !p.hanging && !airborne(p) && m.exitSet.has(room.tileAt(p.x, p.y));
    m.need = need.length;
    m.inExit = need.filter(inside).length;
    if (m.inExit === need.length) {
      m.stageTimes.push(Math.round(room.matchTime - m.stageStart));
      room.endRound({ key: '第 {n} 关通过！', p: { n: m.stage + 1 } });
      room.event({ type: 'stageClear', stage: m.stage });
    }
  },
  matchOver(room) {
    if (room.m.stage + 1 >= STAGES.length) return { winners: room.list().map((p) => p.id), coop: { win: true, stage: room.m.stage }, text: '全部通关！' };
    return null;
  },
  snapshot(room) {
    const m = room.m;
    if (!m.level) return {};
    return {
      stage: m.stage,
      stages: STAGES.length,
      stageName: STAGES[m.stage].name,
      hint: STAGES[m.stage].hint,
      lives: m.lives,
      livesMax: m.livesMax,
      diff: m.diff.name,
      key: m.key ? { x: r1(m.key.x), y: r1(m.key.y), h: m.key.holder, d: m.key.done ? 1 : 0 } : null,
      plates: m.plates.map((p) => ({ x: p.x, y: p.y, on: p.on ? 1 : 0, t: r1(p.t) })),
      kOpen: m.kOpen ? 1 : 0,
      pOpen: m.pOpen ? 1 : 0,
      inExit: m.inExit,
      need: m.need,
      blink: m.blink ? r1(m.blink.t) : -1,
      exit: m.exitAt,
      times: m.stageTimes,
      ropeLen: ROPE_LEN,
    };
  },
  // 机器人：在地砖网格上用广度优先搜索找路，按"钥匙 → 压力板 → 出口"的顺序做任务
  botGoal(room, p, ctx) {
    const m = room.m;
    if (!m.level) return null;
    const f = m.level.feat;
    const chain = rope.chain(room);
    const idx = chain.indexOf(p);
    let target = m.exitAt;
    if (m.key && !m.key.done && (m.key.holder || rope.path(room, p, m.key).reached)) {
      target = m.key.holder ? f.lock : m.key;
    } else if (!m.pOpen && m.plates.length) {
      const n = chain.length;
      if (n <= 1) target = m.plates.reduce((a, b) => (a.t <= b.t ? a : b));
      else {
        const assigned = m.plates.map((pl, j) => Math.round((j * (n - 1)) / Math.max(1, m.plates.length - 1)));
        const mine = assigned.indexOf(idx);
        if (mine >= 0) target = m.plates[mine];
        else {
          // 中间的人站在两块板中间偏下的位置，别把队友拉走
          const cx = m.plates.reduce((s, pl) => s + pl.x, 0) / m.plates.length;
          const cy = m.plates.reduce((s, pl) => s + pl.y, 0) / m.plates.length + 76;
          target = { x: cx, y: cy };
        }
      }
    }
    const route = rope.path(room, p, target);
    // raw：路线已经只走安全地砖，不需要通用的"前方危险就退回"逻辑
    return { x: route.x, y: route.y, raw: true };
  },
  path(room, p, target) {
    const lay = room.map.layout;
    const g = lay.grid;
    const tiles = lay.tiles;
    const cellOf = (x, y) => [Math.floor((x - g.ox) / g.cell), Math.floor((y - g.oy) / g.cell)];
    const [si, sj] = cellOf(p.x, p.y);
    const [ti, tj] = cellOf(target.x, target.y);
    const key = (i, j) => i + ',' + j;
    const walk = (i, j) => {
      const id = g.index.get(key(i, j));
      return id !== undefined && room.tileState[id] === 0;
    };
    const prev = new Map([[key(si, sj), null]]);
    const q = [[si, sj]];
    let best = [si, sj];
    let bd = Math.hypot(si - ti, sj - tj);
    while (q.length) {
      const [i, j] = q.shift();
      const d = Math.hypot(i - ti, j - tj);
      if (d < bd) {
        bd = d;
        best = [i, j];
      }
      if (d === 0) break;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ni = i + di;
        const nj = j + dj;
        const k = key(ni, nj);
        if (prev.has(k) || !walk(ni, nj)) continue;
        prev.set(k, [i, j]);
        q.push([ni, nj]);
      }
    }
    // 从终点倒推，取路线上的第二个格子作为下一步
    const pathCells = [];
    for (let c = best; c; c = prev.get(key(c[0], c[1]))) pathCells.unshift(c);
    const reached = bd === 0;
    if (reached && pathCells.length <= 2) return { x: target.x, y: target.y, reached };
    const step = pathCells[Math.min(1, pathCells.length - 1)];
    const id = g.index.get(key(step[0], step[1]));
    if (id === undefined) return { x: target.x, y: target.y, reached };
    return { x: tiles[id].cx, y: tiles[id].cy, reached };
  },
};

// 夺旗突围：把敌方旗子带回己方旗台；己方旗子没回家时不能得分。
const captureFlag = {
  id: 'captureFlag',
  targets: [3, 5, 7],
  defaultTarget: 3,
  minPlayers: 2,
  teams: true,
  respawn: true,
  respawnDelay: 1.5,
  hazards: { collapse: false, cracks: 'regen', meteors: true },
  setup(room) {
    room.balanceTeams();
  },
  startRound(room) {
    const half = room.map.layout.radius * 0.52;
    const baseAt = (team) => {
      const x = team ? half : -half;
      const tiles = room.map.layout.tiles.filter((t, i) => room.tileState[i] === 0 && (room.map.bumpers || []).every((b) => Math.hypot(t.cx - b.x, t.cy - b.y) > b.r + 36));
      const t = tiles.reduce((best, q) => !best || Math.hypot(q.cx - x, q.cy) < Math.hypot(best.cx - x, best.cy) ? q : best, null);
      return t ? { x: t.cx, y: t.cy } : { x: team ? half * 0.6 : -half * 0.6, y: 0 };
    };
    room.m.bases = [baseAt(0), baseAt(1)];
    room.m.flags = room.m.bases.map((p, team) => ({ team, x: p.x, y: p.y, home: true, carrier: null, cooldown: 0 }));
    room.m.clock = 180;
  },
  accelMul(room, p) {
    return room.m.flags?.some((f) => f.carrier === p.id) ? 0.92 : 1;
  },
  drop(room, p) {
    const f = room.m.flags?.find((q) => q.carrier === p.id);
    if (!f) return;
    f.carrier = null;
    f.home = false;
    f.x = p.x;
    f.y = p.y;
    f.cooldown = 0.8;
    room.event({ type: 'flagDrop', team: f.team, id: p.id, x: r1(p.x), y: r1(p.y) });
  },
  update(room, dt) {
    const m = room.m;
    m.clock = Math.max(0, m.clock - dt);
    if (m.clock === 0) {
      const team = room.teamScore[0] === room.teamScore[1] ? -1 : room.teamScore[0] > room.teamScore[1] ? 0 : 1;
      room.endMatch(team < 0 ? [] : room.list().filter((p) => p.team === team).map((p) => p.id), { winnerTeam: team, text: team < 0 ? '平局！' : '时间到！' });
      return;
    }
    for (const f of m.flags) f.cooldown = Math.max(0, f.cooldown - dt);
    for (const p of alivePlayers(room)) {
      const own = m.flags[p.team];
      const enemy = m.flags[1 - p.team];
      if (own && !own.home && !own.carrier && Math.hypot(p.x - own.x, p.y - own.y) < 38) {
        own.x = m.bases[p.team].x;
        own.y = m.bases[p.team].y;
        own.home = true;
        room.event({ type: 'flagReturn', team: p.team, id: p.id });
      }
      if (!enemy.carrier && enemy.cooldown <= 0 && Math.hypot(p.x - enemy.x, p.y - enemy.y) < 40) {
        enemy.carrier = p.id;
        enemy.home = false;
        room.event({ type: 'flagPick', team: enemy.team, id: p.id });
      }
      if (enemy.carrier === p.id) {
        if (own.home && Math.hypot(p.x - m.bases[p.team].x, p.y - m.bases[p.team].y) < 64) {
          room.teamScore[p.team]++;
          p.score++;
          p.stats.goals++;
          room.event({ type: 'flagCapture', team: p.team, id: p.id, x: p.x, y: p.y, score: room.teamScore[p.team] });
          enemy.carrier = null;
          enemy.x = m.bases[enemy.team].x;
          enemy.y = m.bases[enemy.team].y;
          enemy.home = true;
          enemy.cooldown = 1.2;
          if (room.teamScore[p.team] >= room.settings.target) room.endMatch(room.list().filter((q) => q.team === p.team).map((q) => q.id), { winnerTeam: p.team });
          return;
        }
        enemy.x = p.x;
        enemy.y = p.y;
      }
    }
  },
  onCollide(room, a, b, rel) {
    if (rel < 700 || a.kind !== 'player' || b.kind !== 'player') return;
    const carrier = [a, b].find((p) => room.m.flags.some((f) => f.carrier === p.id));
    const tackler = carrier === a ? b : a;
    if (carrier && room.isEnemy(carrier, tackler) && tackler.fx.shield <= 0 && tackler.fx.ghost <= 0) captureFlag.drop(room, carrier);
  },
  onPlayerFall(room, p) {
    captureFlag.drop(room, p);
  },
  onLeave(room, p) {
    captureFlag.drop(room, p);
  },
  snapshot(room) {
    return { clock: r1(room.m.clock), bases: room.m.bases, flags: room.m.flags.map((f) => {
      const p = f.carrier && room.players.get(f.carrier);
      return { team: f.team, x: r1(p ? p.x : f.x), y: r1(p ? p.y : f.y), z: r1(p ? (p.floorZ || 0) + p.z : room.surfaceAt(f.x, f.y, 0)), home: f.home, carrier: f.carrier };
    }) };
  },
  botGoal(room, p, ctx) {
    const own = room.m.flags[p.team];
    const enemy = room.m.flags[1 - p.team];
    const carrier = room.players.get(own.carrier);
    if (carrier && carrier.id !== p.id) return { x: carrier.x, y: carrier.y, dash: dist(p, carrier) < 150, raw: true };
    if (enemy.carrier === p.id) {
      const home = room.m.bases[p.team];
      return { x: home.x, y: home.y, dash: dist(p, home) > 180, raw: true };
    }
    if (enemy.carrier) {
      const target = room.players.get(enemy.carrier);
      if (target) return { x: target.x, y: target.y, dash: dist(p, target) < 170, raw: true };
    }
    if (!enemy.home && !enemy.carrier) return { x: enemy.x, y: enemy.y, raw: true };
    if (!own.home && !own.carrier) return { x: own.x, y: own.y, raw: true };
    return { x: enemy.x, y: enemy.y, dash: ctx.enemyDist < 120, raw: true };
  },
};

// 引力风暴：每隔数秒改变一次方向，存活到目标轮数获胜。
const gravityStorm = {
  id: 'gravityStorm',
  targets: [3, 5, 7],
  defaultTarget: 3,
  minPlayers: 2,
  hazards: { collapse: true, cracks: 'permanent', meteors: true },
  setup(room) {
    room.m.gravityPhase = 0;
    room.m.gravityTime = 7;
  },
  update(room, dt) {
    const m = room.m;
    m.gravityTime -= dt;
    if (m.gravityTime <= 0) {
      m.gravityPhase = (m.gravityPhase + 1) % 4;
      m.gravityTime = 7;
      room.event({ type: 'gravityShift', phase: m.gravityPhase });
    }
    for (const p of alivePlayers(room)) {
      const d = Math.hypot(p.x, p.y) || 1;
      const inward = [-p.x / d, -p.y / d];
      const force = m.gravityPhase === 0 ? inward : m.gravityPhase === 1 ? inward.map((v) => -v) : m.gravityPhase === 2 ? [-inward[1], inward[0]] : [inward[1], -inward[0]];
      p.vx += force[0] * 210 * dt;
      p.vy += force[1] * 210 * dt;
    }
  },
  check: eliminationCheck,
  matchOver: roundWinners,
  snapshot(room) {
    return { gravityPhase: room.m.gravityPhase, gravityTime: r1(room.m.gravityTime) };
  },
};

// 怪物浪潮：三波小怪后打最终 Boss。复用 Boss 的敌人 AI、技能、动画和共享复活规则。
const monsterWave = {
  id: 'monsterWave',
  targets: [1, 2, 3],
  defaultTarget: 2,
  targetNames: { 1: '简单', 2: '普通', 3: '困难' },
  label: '难度',
  unit: '',
  minPlayers: 1,
  coop: true,
  respawn: true,
  respawnDelay: 2.5,
  hazards: { collapse: false, cracks: 'regen', meteors: true },
  setup(room) {
    boss.setup(room);
    room.m.wave = 1;
    room.m.waveMax = 4;
    room.m.spawned = 0;
    room.m.waveTotal = [3, 4, 5];
    room.m.waveTimer = 0.7;
    room.m.intermission = 0;
    room.m.defeated = 0;
    room.m.bossLives = room.m.bossLivesMax = 1;
    room.m.enraged = false;
  },
  startRound(room) {
    room.m.slam = null;
    room.m.boss = null;
  },
  spawn: boss.spawn,
  skill: boss.skill,
  control: boss.control,
  update(room, dt) {
    const m = room.m;
    if (m.wave < 4) {
      const alive = room.bodies.filter((b) => b.kind === 'minion' && b.alive).length;
      const total = m.waveTotal[m.wave - 1];
      if (m.spawned < total) {
        m.waveTimer -= dt;
        if (m.waveTimer <= 0) {
          boss.spawnMinion(room);
          m.spawned++;
          m.waveTimer = 1.5;
          if (m.spawned === total) m.intermission = 2;
        }
      } else if (alive === 0) {
        m.intermission -= dt;
        if (m.intermission <= 0) {
          m.wave++;
          m.defeated = 0;
          room.event({ type: 'waveStart', wave: m.wave });
          if (m.wave < 4) {
            m.spawned = 0;
            m.waveTimer = 0.8;
          } else {
            boss.spawnBoss(room, 1.2);
            m.bossLives = m.bossLivesMax = 1;
            m.phase = 1;
            room.event({ type: 'waveBoss' });
          }
        }
      }
    } else if (m.boss) {
      boss.update(room, dt);
    }
    for (const p of room.list()) p.score = p.stats.kills;
  },
  onCollide: boss.onCollide,
  onBodyFall(room, b) {
    const finisher = b.lastHitBy && room.roundTime - b.lastHitTime < 5 ? room.players.get(b.lastHitBy) : null;
    if (b.kind === 'minion') {
      if (finisher) finisher.stats.kills++;
      room.m.defeated++;
      room.event({ type: 'minionDown', id: finisher ? finisher.id : null, x: b.x, y: b.y });
      const buffs = ['speed', 'shield', 'big', 'freeze'];
      if (room.settings.items && room.items.length < 3 && Math.random() < 0.35 && room.safeAt(b.x, b.y)) room.items.push({ id: room.nextObj++, type: buffs[Math.floor(Math.random() * buffs.length)], x: b.x, y: b.y });
    } else if (b.kind === 'boss') {
      if (finisher) finisher.stats.finishers++;
      room.m.boss = null;
      room.event({ type: 'bossDown', id: finisher ? finisher.id : null, lives: 0, x: b.x, y: b.y });
      room.endMatch(room.list().map((p) => p.id), { coop: { win: true }, text: '成功击败全部怪物！' });
    }
  },
  onPlayerFall(room, p) {
    if (room.m.lives > 0) room.m.lives--;
    else p.out = true;
  },
  canRespawn: (room, p) => !p.out,
  check(room) {
    const list = room.list();
    if (list.length && !list.some((p) => (p.alive && !p.falling) || p.falling > 0 || (!p.out && p.respawn > 0))) room.endMatch([], { coop: { win: false }, text: '全员阵亡……' });
  },
  snapshot(room) {
    return { ...boss.snapshot(room), wave: room.m.wave, waveMax: room.m.waveMax, spawned: room.m.spawned, total: room.m.wave < 4 ? room.m.waveTotal[room.m.wave - 1] : 1 };
  },
  botGoal(room, p, ctx) {
    if (room.m.boss) return boss.botGoal(room, p, ctx);
    const enemy = room.bodies.filter((b) => b.kind === 'minion' && b.alive && !b.falling).sort((a, b) => dist(p, a) - dist(p, b))[0];
    if (!enemy) return ctx.refuge;
    const d = Math.hypot(enemy.x, enemy.y) || 1;
    return { x: enemy.x - enemy.x / d * (enemy.r + 18), y: enemy.y - enemy.y / d * (enemy.r + 18), dash: dist(p, enemy) < 110 };
  },
};

// 浮台竞速：四块浮台绕场移动，按顺序跳上去，先完成目标圈数获胜。
const RACE_PAD_Z = 46;
const platformRace = {
  id: 'platformRace',
  targets: [1, 2, 3],
  defaultTarget: 1,
  targetNames: { 1: '1 圈', 2: '2 圈', 3: '3 圈' },
  label: '圈数',
  unit: '',
  minPlayers: 1,
  respawn: true,
  respawnDelay: 1.5,
  hazards: { collapse: false, cracks: 'regen', meteors: false },
  spawn(room, p, i, list) {
    const radius = Math.min(155, room.map.layout.radius * 0.3);
    const angle = (i / list.length) * Math.PI * 2;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  },
  startRound(room) {
    const radius = Math.min(176, room.map.layout.radius * 0.34);
    room.m.platforms = Array.from({ length: 4 }, (_, id) => ({ id, angle: id * Math.PI / 2, radius, speed: id % 2 ? -0.27 : 0.27, x: 0, y: 0, z: RACE_PAD_Z, r: 62 }));
    for (const p of room.list()) {
      p.raceProgress = 0;
      p.score = 0;
      p.raceJumpCd = 0;
    }
    platformRace.placePads(room);
  },
  placePads(room) {
    for (const pad of room.m.platforms) {
      pad.x = Math.cos(pad.angle) * pad.radius;
      pad.y = Math.sin(pad.angle) * pad.radius;
    }
  },
  platformAt(room, x, y) {
    return room.m.platforms?.find((pad) => Math.hypot(pad.x - x, pad.y - y) < pad.r - 7) || null;
  },
  beforePhysics(room, dt) {
    for (const p of room.list()) p.raceJumpCd = Math.max(0, (p.raceJumpCd || 0) - dt);
    for (const pad of room.m.platforms) {
      const x = pad.x;
      const y = pad.y;
      const riders = room.list().filter((p) => p.alive && !p.falling && !p.hanging && !airborne(p) && p.floorZ === pad.z && Math.hypot(p.x - x, p.y - y) < pad.r - 7);
      pad.angle += pad.speed * dt;
      pad.x = Math.cos(pad.angle) * pad.radius;
      pad.y = Math.sin(pad.angle) * pad.radius;
      for (const p of riders) {
        p.x += pad.x - x;
        p.y += pad.y - y;
      }
    }
  },
  update(room) {
    const goal = room.settings.target * room.m.platforms.length;
    for (const p of alivePlayers(room)) {
      if (p.floorZ !== RACE_PAD_Z || airborne(p)) continue;
      const checkpoint = (p.raceProgress || 0) % room.m.platforms.length;
      const pad = room.m.platforms[checkpoint];
      if (Math.hypot(p.x - pad.x, p.y - pad.y) >= pad.r - 12) continue;
      p.raceProgress++;
      p.score = p.raceProgress;
      room.event({ type: 'raceCheckpoint', id: p.id, checkpoint: p.raceProgress, x: p.x, y: p.y });
      if (p.raceProgress >= goal) {
        room.endMatch([p.id], { text: '竞速冠军！' });
        return;
      }
    }
  },
  snapshot(room) {
    return { platforms: room.m.platforms.map(({ id, x, y, z, r }) => ({ id, x: r1(x), y: r1(y), z, r })), checkpoints: room.settings.target * 4, perLap: 4 };
  },
  botGoal(room, p) {
    const pad = room.m.platforms[(p.raceProgress || 0) % room.m.platforms.length];
    if (p.floorZ < RACE_PAD_Z && p.z <= 0 && p.raceJumpCd <= 0 && Math.hypot(p.x - pad.x, p.y - pad.y) < 100) {
      p.input.jump = true;
      p.raceJumpCd = 0.7;
    }
    return { x: pad.x, y: pad.y };
  },
};

const MODES = { classic, teamBrawl, football, infection, hideSeek, hill, soloHill, crown, paint, potato, boss, rope, captureFlag, gravityStorm, monsterWave, platformRace };
module.exports = { MODES, MODE_IDS: Object.keys(MODES) };
