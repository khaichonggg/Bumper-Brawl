// 预热 shader：比赛里才第一次出现的东西，开机后趁空闲在后台先把 shader 编好。
//
// three.js 要等物体第一次出现在画面上才编译它的 shader，而且是同步编译：Windows 的 Chrome 把 WebGL 翻译成
// Direct3D，一个 shader 要 100-300ms（KC 的 GTX 650 上实测比赛中第一次出现新道具时卡了 750ms）。
// 第一次用幽灵道具更糟：角色所有材质都要换成"半透明"版本重新编译。
// 这里在菜单里空闲时，把道具、龙卷风、陨石、Boss、足球、各种角色 / 皮肤 / 帽子、幽灵版本都在后台编译一遍，
// 每次只编一两个（编译很吃 CPU，一次全丢进去画面会顿）。编好的材质留着不释放，shader 就一直留在缓存里。
import * as THREE from 'three';
import { scene, precompile, warmBloom, parallelCompile } from './core.js';
import { Character } from './character.js';
import { makeItemModel, makeTornado, makeBanana, makeMeteor, makeBall, makeBoss, makeMinion, makeGoals } from './objects.js';
import { CHARACTERS, SKINS, HATS, COLORS, ITEMS, TEAM_COLORS } from '../data.js';

const kept = new Set(); // 编译过的材质：不 dispose，shader 才不会被 three.js 回收
const stat = { state: 'idle', fresh: 0, ms: 0, groups: 0 };
let started = false;

// 调用会把模型直接加进场景的工厂函数，把新加的东西拿出来（预热用的模型不能出现在画面上）
function capture(make) {
  const n = scene.children.length;
  const ret = make();
  const added = scene.children.slice(n);
  for (const o of added) scene.remove(o);
  if (!added.length && ret && ret.isObject3D) added.push(ret);
  const g = new THREE.Group();
  for (const o of added) g.add(o);
  return g;
}

// 每组一个"任务"：造出模型 → 后台编译 → 只留下材质
function objectJobs() {
  const jobs = Object.keys(ITEMS).map((type) => () => capture(() => makeItemModel(type)));
  jobs.push(
    () => capture(() => makeTornado()),
    () => capture(() => makeBanana(1.3)),
    () => capture(() => makeMeteor()),
    () => capture(() => makeBall(40)),
    () => capture(() => makeBoss()),
    () => capture(() => makeMinion()),
    () => capture(() => makeGoals({ x: 350, hw: 45, hh: 100 }))
  );
  return jobs;
}

// 角色：让每种角色、每种皮肤、每顶帽子都至少出现一次（拉丁方式排列，11 个就够），再加一个带队伍腰带的
function characterJobs() {
  const n = Math.max(CHARACTERS.length, SKINS.length, HATS.length);
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const profile = { char: CHARACTERS[i % CHARACTERS.length].id, skin: SKINS[i % SKINS.length].id, hat: HATS[i % HATS.length].id, color: COLORS[i % COLORS.length] };
    jobs.push({ profile, opts: {} });
  }
  jobs.push({ profile: { char: CHARACTERS[0].id, skin: 'solid', hat: 'none', color: COLORS[0] }, opts: { teamColor: TEAM_COLORS[0], team: 0 } });
  return jobs;
}

// 幽灵道具会把角色的材质临时改成半透明（transparent 会换 shader）：给每个不透明材质做一个半透明的副本也编一遍
function ghostVariant(ch) {
  const mats = Array.isArray(ch.mats) && ch.mats.length ? ch.mats : null;
  const swap = new Map();
  ch.root.traverse((o) => {
    if (!o.material || Array.isArray(o.material)) return;
    const m = o.material;
    if (m.transparent || (mats && !mats.includes(m))) return;
    let c = swap.get(m);
    if (!c) {
      c = m.clone();
      c.transparent = true;
      c.depthWrite = false;
      swap.set(m, c);
    }
    o.material = c;
  });
  return swap.size > 0;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

async function compileGroup(root, inFlight) {
  const { materials, fresh } = await precompile([root], { inFlight });
  for (const m of materials) kept.add(m);
  stat.fresh += fresh;
  stat.groups++;
}

/**
 * 开始后台预热（开机后调用一次）。
 * @param {() => boolean} [inMatch] 正在比赛吗：比赛中只编一个一个地编；浏览器不支持后台编译时比赛中先暂停
 */
export async function start(inMatch = () => false) {
  if (started) return;
  started = true;
  const t0 = performance.now();
  stat.state = 'running';
  // 菜单里同时编两个；比赛中一次一个。没有后台编译扩展时每个都会让画面顿一下：比赛中先停下，回到大厅再继续
  let inFlight = 2;
  const wait = async () => {
    await nextFrame();
    while (!parallelCompile && inMatch()) await new Promise((r) => setTimeout(r, 500));
    inFlight = parallelCompile && !inMatch() ? 2 : 1;
  };
  try {
    await wait();
    await warmBloom(inFlight);
    for (const make of objectJobs()) {
      await wait();
      await compileGroup(make(), inFlight);
    }
    for (const { profile, opts } of characterJobs()) {
      await wait();
      const ch = new Character(profile, opts);
      await compileGroup(ch.root, inFlight);
      if (ghostVariant(ch)) await compileGroup(ch.root, inFlight);
    }
    stat.state = 'done';
  } catch (e) {
    // 预热只是锦上添花：出错了就算了，游戏照常（最坏情况是比赛中第一次出现时卡一下）
    stat.state = 'failed';
    console.warn('shader warmup', e);
  }
  stat.ms = Math.round(performance.now() - t0);
}

/** 调试 / 测量用 */
export const info = () => ({ ...stat, kept: kept.size });
