// 主循环调度：按真实流逝的时间跑固定步长的模拟，再按模拟时间每 2 帧广播一次
//
// 为什么不用 setInterval(1000/60)：Windows 上 Node 的定时器精度只有约 15.6ms，
// 请求 16.7ms 实际要等两个刻度（约 31ms），一秒只跑 36 次。以前每次都按 1/60 秒模拟，
// 整个游戏就慢了将近四成（移动、倒计时、冷却都变慢），快照也只剩 18Hz，画面一顿一顿的。
// 现在用 process.hrtime 计时、把欠下的帧补上（累加器），模拟速度和真实时间一致。
const hrMs = () => Number(process.hrtime.bigint()) / 1e6;

/**
 * 创建固定步长主循环。
 * @param {object} o
 * @param {number} o.tickRate 模拟频率（Hz）
 * @param {number} o.sendRate 广播频率（Hz，按模拟时间计）
 * @param {(dt:number, tick:number) => void} o.onTick 每个模拟帧调用一次
 * @param {(simMs:number, tick:number) => void} o.onSend 该广播时调用，simMs 是当前模拟时间（毫秒）
 * @param {number} [o.maxCatchUp] 一次醒来最多补几帧（进程被卡住很久后不要一口气补几百帧）
 * @param {boolean} [o.coarseTimers] 定时器是否粗粒度（默认：Windows 为 true）
 * @param {() => number} [o.now] 取当前时间（毫秒），测试用
 * @returns {{ start():void, stop():void, stats: object }}
 */
function createLoop({ tickRate, sendRate, onTick, onSend, maxCatchUp = 6, coarseTimers = process.platform === 'win32', now = hrMs }) {
  const stepMs = 1000 / tickRate;
  const ticksPerSend = Math.max(1, Math.round(tickRate / sendRate));
  const stats = { ticks: 0, sends: 0, wakeups: 0, dropped: 0 };
  let acc = 0;
  let last = 0;
  let sinceSend = 0;
  let timer = null;
  let running = false;

  function schedule() {
    if (!running) return;
    const wait = stepMs - acc; // 离下一帧还差多少毫秒
    // 粗粒度定时器（Windows）：请求 1ms 就会在下一个刻度（约 15.6ms 后）醒来，正好略快于 60Hz，
    // 醒来时按真实时间补帧；请求 16ms 反而要等两个刻度。精确定时器：直接等到下一帧。
    const delay = coarseTimers ? (wait > 17 ? wait - 16 : 1) : Math.max(1, Math.ceil(wait));
    timer = setTimeout(run, delay);
  }

  function run() {
    try {
      const t = now();
      acc += t - last;
      last = t;
      stats.wakeups++;
      if (acc > stepMs * maxCatchUp) {
        // 进程被卡住（控制台被点住、电脑睡眠）：丢掉多出来的时间，游戏从这里接着跑
        stats.dropped += Math.floor(acc / stepMs) - maxCatchUp;
        acc = stepMs * maxCatchUp;
      }
      while (acc >= stepMs) {
        acc -= stepMs;
        stats.ticks++;
        sinceSend++;
        onTick(1 / tickRate, stats.ticks);
      }
      if (sinceSend >= ticksPerSend) {
        sinceSend = 0;
        stats.sends++;
        onSend(stats.ticks * stepMs, stats.ticks);
      }
    } finally {
      schedule(); // 回调里出错也要继续跑，别让主循环停掉
    }
  }

  return {
    stats,
    start() {
      if (running) return;
      running = true;
      last = now();
      schedule();
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}

module.exports = { createLoop };
