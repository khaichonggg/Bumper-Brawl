// Boss 砸地的动画曲线（没有依赖，测试可以直接导入）。
// 以前客户端自己"弹上去、状态变了再掉下来"：画面上落地比服务器的冲击波晚了大约 0.5 秒，
// 照着"落地那一刻跳"去做的人每次都被砸中。现在服务器在快照里带上"离砸下来还有几秒"（m.bossT），
// 动画完全按它来算：画面上砸到地面的那一刻，就是冲击波的那一刻。
// 这些数字必须和 server/modes.js 的 BOSS_SLAM_WIND / BOSS_SLAM_TELL 一致（test/client.test.js 会检查）。

export const SLAM_WIND = 1.3; // 蓄力总时长
export const SLAM_TELL = 0.45; // 砸下来前多久在空中停住、闪白光、呼啸（"现在跳"）
export const SLAM_PLUNGE = 0.3; // 最后多久往下砸
export const SLAM_H = 260; // 跳到多高
const HOVER_UP = 20; // 停住时再往上提一点点（蓄力的"顿"一下）

/**
 * 离砸下来还有 T 秒时，Boss 离地多高。
 * 蓄力：先快后慢地升到 SLAM_H；停住：再往上提一点；最后 SLAM_PLUNGE 秒加速砸下来，T = 0 时正好落地。
 * @param {number|null|undefined} T 快照里的 m.bossT（不在蓄力砸地时是 null）
 * @returns {number} 离地高度（>= 0）
 */
export function slamHeight(T) {
  if (typeof T !== 'number' || !(T > 0)) return 0;
  if (T <= SLAM_PLUNGE) {
    const k = 1 - T / SLAM_PLUNGE; // 0 → 1：像自由落体一样越砸越快
    return (SLAM_H + HOVER_UP) * (1 - k * k);
  }
  if (T <= SLAM_TELL) return SLAM_H + HOVER_UP * Math.sin(((SLAM_TELL - T) / (SLAM_TELL - SLAM_PLUNGE)) * (Math.PI / 2));
  const u = Math.min(1, Math.max(0, (SLAM_WIND - T) / (SLAM_WIND - SLAM_TELL)));
  return SLAM_H * (1 - (1 - u) * (1 - u) * (1 - u));
}

/**
 * 地上红圈里"填满"的进度：蓄力开始时是 0，砸下来那一刻正好填满（又一个看时机的提示）。
 * @param {number|null|undefined} T 快照里的 m.bossT
 * @returns {number} 0~1
 */
export function slamProgress(T) {
  if (typeof T !== 'number') return 0;
  return Math.min(1, Math.max(0, 1 - T / SLAM_WIND));
}
