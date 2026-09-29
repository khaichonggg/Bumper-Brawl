// 机器人 AI：先看模式有没有特殊目标，没有就按"找人撞、捡道具、别掉下去"的通用逻辑走。
// 掉线的真人玩家也由这里托管。
const { BOT_LEVELS, DASH_IMPULSE, JUMP_V, GRAVITY } = require('./constants');
const { rand, dist, radiusOf, airborne, controllable } = require('./util');

const AIR_TIME = (2 * JUMP_V) / GRAVITY; // 一次跳跃的滞空时间
// 各难度"该跳的时候跳"的概率：简单的机器人经常反应不过来
const JUMP_SKILL = [0.45, 0.75, 0.95];
// 被人冲刺撞过来时跳起来躲的概率。故意很低：冲过去撞机器人是这个游戏最核心的乐趣，
// 机器人老是跳开会让人觉得"冲刺没用"（普通难度大约 85% 的冲刺都能撞上）
const DASH_DODGE = [0.08, 0.15, 0.25];

function analyze(room, p) {
  const tiles = room.map.layout.tiles;
  // 最安全的落脚点：状态正常、越靠内越好、离自己越近越好
  let refuge = null;
  let best = -Infinity;
  for (let i = 0; i < tiles.length; i++) {
    if (room.tileState[i] !== 0) continue;
    const t = tiles[i];
    const s = t.layer * 60 - Math.hypot(t.cx - p.x, t.cy - p.y) * 0.5;
    if (s > best) {
      best = s;
      refuge = t;
    }
  }
  let nearestEnemy = null;
  let enemyDist = Infinity;
  for (const o of room.activeBodies()) {
    if (o === p || o.kind === 'ball' || !room.isEnemy(p, o) || (o.fx && o.fx.ghost > 0)) continue;
    const d = dist(p, o);
    if (d < enemyDist) {
      enemyDist = d;
      nearestEnemy = o;
    }
  }
  let item = null;
  let itemDist = Infinity;
  for (const it of room.items) {
    const d = Math.hypot(it.x - p.x, it.y - p.y);
    if (d < itemDist) {
      itemDist = d;
      item = it;
    }
  }
  return { refuge: refuge ? { x: refuge.cx, y: refuge.cy } : { x: 0, y: 0 }, nearestEnemy, enemyDist, item, itemDist };
}

// 危险区域：陨石落点、龙卷风、Boss 砸地
function danger(room, p) {
  for (const m of room.meteors) {
    if (Math.hypot(p.x - m.x, p.y - m.y) < m.r + 45) return { x: p.x + (p.x - m.x || 1), y: p.y + (p.y - m.y) };
  }
  for (const h of room.hazards) {
    if (h.owner !== p.id && Math.hypot(p.x - h.x, p.y - h.y) < 140) return { x: p.x + (p.x - h.x || 1), y: p.y + (p.y - h.y) };
  }
  return null;
}

// 机器人什么时候用手上的道具
function maybeUseItem(room, p, ctx, lvl) {
  if (!p.item) {
    p.itemHold = 0;
    return;
  }
  p.itemHold = (p.itemHold || 0) + lvl.think;
  const d = ctx.enemyDist;
  let use = false;
  switch (p.item) {
    case 'bomb':
      use = d < 150;
      break;
    case 'freeze':
      use = d < 170;
      break;
    case 'tornado':
      use = d < 380;
      break;
    case 'banana':
      use = d < 260 || p.itemHold > 4;
      break;
    case 'shield':
    case 'big':
      use = d < 200 || !room.safeAt(p.x, p.y);
      break;
    default: // speed / ghost
      use = p.itemHold > 1.2 + Math.random() * 1.5;
  }
  // 拿太久了就随便用掉（别一直攥着）
  if (use || p.itemHold > 8) room.useItem(p);
}

// 跳跃反射：每帧都看（思考间隔太长，赶不上 Boss 砸地那一下）。
// 只在三种情况下跳：躲 Boss 砸地、躲迎面冲过来的人、跳过前面的小缺口；跳完歇一会儿，不会一直蹦
function reflex(room, p, dt) {
  p.botJumpCd = Math.max(0, (p.botJumpCd || 0) - dt);
  if (p.botJumpCd > 0 || airborne(p) || p.hanging || !controllable(p)) return;
  const skill = JUMP_SKILL[room.settings.botLevel] ?? JUMP_SKILL[1];
  // 起跳后大约落在哪：要是那里没有地面就别跳
  const landSafe = () => room.safeAt(p.x + p.vx * AIR_TIME * 0.85, p.y + p.vy * AIR_TIME * 0.85);
  let jump = false;
  let rest = rand(0.9, 1.6); // 跳完歇多久

  // 1. Boss 砸地：每次砸地只决定一次躲不躲，在落下前 0.15~0.4 秒起跳
  const boss = room.m && room.m.boss;
  if (boss && boss.state === 'slamWind' && dist(p, boss) < 230 + radiusOf(p)) {
    if (p.dodgeSlam !== boss.slams) {
      p.dodgeSlam = boss.slams;
      p.dodgeAt = Math.random() < skill ? rand(0.15, 0.4) : -1;
    }
    if (p.dodgeAt > 0 && boss.stateT <= p.dodgeAt) jump = true;
  }

  // 2. 有人刚冲刺、正撞过来：还有 0.1~0.22 秒撞上时，偶尔跳起来让他从脚下冲过去
  if (!jump) {
    for (const o of room.activeBodies()) {
      if (o === p || o.kind !== 'player' || !room.isEnemy(p, o) || airborne(o)) continue;
      if (!(room.roundTime - (o.dashT ?? -99) < 0.6)) continue; // 只躲冲刺，被撞飞过来的人不算
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d > 220 || d < 1) continue;
      const closing = ((o.vx - p.vx) * dx + (o.vy - p.vy) * dy) / d;
      if (closing < 600) continue;
      const eta = (d - radiusOf(p) - radiusOf(o)) / closing;
      if (eta < 0.1 || eta > 0.22) continue;
      // 同一个人的同一次冲刺只掷一次骰子；躲过一次之后歇 3~5 秒，不会连着躲
      const key = o.id + ':' + o.dashN;
      if (p.dodgeDash !== key) {
        p.dodgeDash = key;
        if (Math.random() < (DASH_DODGE[room.settings.botLevel] ?? DASH_DODGE[1]) && landSafe()) {
          jump = true;
          rest = rand(3, 5);
        }
      }
      break;
    }
  }

  // 3. 正往前跑、脚下还安全、前面是一两块塌掉的地砖、再往前有地面：跳过去
  if (!jump) {
    const sp = Math.hypot(p.vx, p.vy);
    const il = Math.hypot(p.input.x, p.input.y);
    if (sp > 250 && il > 0.5 && (p.vx * p.input.x + p.vy * p.input.y) / (sp * il) > 0.8 && room.safeAt(p.x, p.y)) {
      const ux = p.vx / sp;
      const uy = p.vy / sp;
      const edge = radiusOf(p) + 12;
      const reach = sp * AIR_TIME * 0.8;
      const gapAhead = !room.safeAt(p.x + ux * edge, p.y + uy * edge);
      const landing = [0.7, 0.85, 1].every((k) => room.safeAt(p.x + ux * reach * k, p.y + uy * reach * k));
      if (gapAhead && landing && Math.random() < skill) jump = true;
    }
  }

  if (jump) {
    p.input.jump = true;
    p.botJumpCd = rest;
  }
}

function think(room, p, dt) {
  reflex(room, p, dt);
  p.botThink -= dt;
  if (p.botThink > 0) return;
  const lvl = BOT_LEVELS[room.settings.botLevel] || BOT_LEVELS[1];
  p.botThink = rand(lvl.think * 0.7, lvl.think * 1.3);
  p.input.dash = false;
  const ctx = analyze(room, p);
  maybeUseItem(room, p, ctx, lvl);
  let goal = danger(room, p);

  if (!goal && room.mode.botGoal) goal = room.mode.botGoal(room, p, ctx);
  if (!goal) {
    // 通用：道具比敌人近就去捡，否则从敌人"靠内"的一侧撞过去
    const e = ctx.nearestEnemy;
    if (ctx.item && ctx.itemDist < 230 && ctx.itemDist < ctx.enemyDist && room.safeAt(ctx.item.x, ctx.item.y)) {
      goal = { x: ctx.item.x, y: ctx.item.y };
    } else if (e) {
      const ox = e.x - ctx.refuge.x;
      const oy = e.y - ctx.refuge.y;
      const ol = Math.hypot(ox, oy) || 1;
      const scared = e.fx && e.fx.shield > 0 && p.fx.shield <= 0;
      goal = { x: e.x - (ox / ol) * 25, y: e.y - (oy / ol) * 25, dash: !scared && ctx.enemyDist < 115 };
      if (scared) goal = { x: p.x * 2 - goal.x, y: p.y * 2 - goal.y };
    } else {
      goal = ctx.refuge;
    }
  }

  let dx = goal.x - p.x;
  let dy = goal.y - p.y;
  let dash = !!goal.dash && Math.random() < lvl.dash;
  // 前方不安全就回安全区；脚下在预警就冲刺逃跑
  const l = Math.hypot(dx, dy) || 1;
  // 地面越滑（阻尼越小）看得越远
  const damping = room.map.physics.damping;
  const slip = Math.max(1, 2.4 / damping);
  const look = lvl.safety * slip + radiusOf(p);
  const hereSafe = room.safeAt(p.x, p.y);
  // 按当前速度预测会滑到哪里（冰面上滑得更远），要滑出去就提前刹车
  const sp = Math.hypot(p.vx, p.vy);
  const stop = Math.min(500, (sp / damping) * 0.9) + radiusOf(p);
  const sliding = sp > 60 && !room.safeAt(p.x + (p.vx / sp) * stop, p.y + (p.vy / sp) * stop);
  if (goal.raw) {
    // 模式自己规划好了路线：只在要滑出去的时候刹车
    if (sliding) {
      dx = dx / l - (p.vx / sp) * 1.2;
      dy = dy / l - (p.vy / sp) * 1.2;
    }
  } else if (sliding || !room.safeAt(p.x + (dx / l) * look, p.y + (dy / l) * look) || !hereSafe) {
    dx = ctx.refuge.x - p.x;
    dy = ctx.refuge.y - p.y;
    if (sliding) {
      const rl = Math.hypot(dx, dy) || 1;
      dx = dx / rl - p.vx / sp;
      dy = dy / rl - p.vy / sp;
    }
    dash = !hereSafe && Math.random() < 0.4;
  }
  const len = Math.hypot(dx, dy) || 1;
  // 冲刺会滑很远：整条冲刺路线都安全才冲（逃离预警地砖时除外）
  if (dash && hereSafe) {
    const reach = Math.max(lvl.safety * 2.6, (DASH_IMPULSE / damping) * 0.7 * (lvl.safety / 90));
    for (const k of [0.4, 0.7, 1]) {
      if (!room.safeAt(p.x + (dx / len) * reach * k, p.y + (dy / len) * reach * k)) dash = false;
    }
  }
  const wobble = (Math.random() - 0.5) * lvl.noise;
  p.input.x = dx / len + wobble;
  p.input.y = dy / len - wobble;
  p.input.dash = dash && p.dashCd <= 0;
}

module.exports = { think };
