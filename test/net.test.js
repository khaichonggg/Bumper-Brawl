// 主循环节奏 + 联网健壮性：固定步长补帧、快照带服务器时间和序号、心跳踢掉没反应的连接、大消息不断线
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('../server/vendor/ws');
const { createLoop } = require('../server/loop');
const { check, done } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hrMs = () => Number(process.hrtime.bigint()) / 1e6;

// 跑一段真实时间，统计模拟帧数、广播次数
async function runLoop(ms, opts = {}) {
  let ticks = 0;
  const sends = [];
  const loop = createLoop({ tickRate: 60, sendRate: 30, onTick: () => ticks++, onSend: (simMs) => sends.push({ simMs, at: hrMs() }), ...opts });
  const t0 = hrMs();
  loop.start();
  await sleep(ms);
  loop.stop();
  return { ticks, sends, real: hrMs() - t0, stats: loop.stats };
}

(async () => {
  console.log('主循环');
  for (const coarse of [true, false]) {
    const r = await runLoop(1500, { coarseTimers: coarse });
    const hz = (r.ticks / r.real) * 1000;
    const sendHz = (r.sends.length / r.real) * 1000;
    check(Math.abs(hz - 60) < 4, `${coarse ? '粗粒度定时器（Windows）' : '精确定时器'}：模拟速度跟真实时间一致（${hz.toFixed(1)} 帧/秒）`);
    check(Math.abs(sendHz - 30) < 3, `  广播约 30 次/秒（${sendHz.toFixed(1)}）`);
    const simGaps = r.sends.slice(1).map((s, i) => s.simMs - r.sends[i].simMs);
    check(simGaps.every((g) => g >= 33 && g <= 101), '  每次广播之间的模拟时间是 2 帧的整数倍');
  }

  // 进程被卡住（比如控制台被点住）之后，不会一口气补几百帧
  {
    let ticks = 0;
    let blocked = false;
    const loop = createLoop({
      tickRate: 60,
      sendRate: 30,
      maxCatchUp: 6,
      onTick: () => {
        ticks++;
        if (!blocked && ticks === 5) {
          blocked = true;
          const until = hrMs() + 400;
          while (hrMs() < until) {
            /* 模拟卡住 400ms */
          }
        }
      },
      onSend: () => {},
    });
    loop.start();
    await sleep(700);
    loop.stop();
    check(loop.stats.dropped > 10, `卡住 400ms 后丢掉多余的帧（丢了 ${loop.stats.dropped} 帧），不会补跑`);
    check(ticks < 60, `  0.7 秒里只跑了 ${ticks} 帧`);
  }

  // 回调出错时主循环不能停
  {
    let ticks = 0;
    const loop = createLoop({
      tickRate: 60,
      sendRate: 30,
      onTick: () => {
        ticks++;
        if (ticks === 3) throw new Error('boom');
      },
      onSend: () => {},
    });
    const oldHandlers = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    let caught = 0;
    process.on('uncaughtException', () => caught++);
    loop.start();
    await sleep(300);
    loop.stop();
    process.removeAllListeners('uncaughtException');
    for (const h of oldHandlers) process.on('uncaughtException', h);
    check(ticks > 10 && caught === 1, `回调抛错后主循环继续运行（${ticks} 帧）`);
  }

  console.log('服务器');
  const PORT = 3405 + Math.floor(Math.random() * 20); // 本任务可用端口 3400-3424（3400 留给手动测试的服务器）
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), LEADERBOARD_FILE: 'off', BB_HEARTBEAT_MS: '200' },
    stdio: 'pipe',
  });
  let out = '';
  srv.stdout.on('data', (d) => (out += d));
  srv.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 50 && !out.includes('已启动'); i++) await sleep(100);
  const open = (opts) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, opts);
      const c = { ws, states: [], msgs: [], closed: false };
      ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        if (m.t === 'state') c.states.push({ ...m, at: hrMs() });
        else c.msgs.push(m);
      });
      ws.on('close', () => (c.closed = true));
      ws.on('open', () => resolve(c));
      ws.on('error', reject);
    });
  try {
    const a = await open();
    a.ws.send(JSON.stringify({ t: 'join', room: '', name: '甲', token: 'net-a' }));
    await sleep(300);
    const code = a.msgs.find((m) => m.t === 'joined').code;
    a.ws.send(JSON.stringify({ t: 'addBot' }));
    a.ws.send(JSON.stringify({ t: 'addBot' }));
    await sleep(100);
    a.ws.send(JSON.stringify({ t: 'start', force: true }));
    await sleep(1500);
    const s = a.states;
    check(s.length > 20 && s.every((x) => typeof x.st === 'number' && typeof x.sq === 'number'), `快照带服务器时间 st 和序号 sq（收到 ${s.length} 个）`);
    check(s.slice(1).every((x, i) => x.sq === s[i].sq + 1 && x.st > s[i].st), '  序号连续、时间递增');
    const span = s[s.length - 1].st - s[0].st;
    const real = s[s.length - 1].at - s[0].at;
    check(Math.abs(span - real) < 80, `  服务器时间和真实时间同步（${span}ms / ${real.toFixed(0)}ms）`);
    const rate = ((s.length - 1) / real) * 1000;
    check(rate > 26 && rate < 34, `  快照约 30 次/秒（${rate.toFixed(1)}）`);

    // 语音的 SDP 有 6-10KB：40KB 的消息不能把连接断掉
    a.ws.send(JSON.stringify({ t: 'ping', c: 'x'.repeat(40000) }));
    await sleep(300);
    const pong = a.msgs.find((m) => m.t === 'pong');
    check(!a.closed && pong && pong.c.length === 40000, '40KB 的消息正常收发，连接不断');

    // 心跳：不回 pong 的连接（手机锁屏、网络断了）会被踢掉；正常的连接保持
    const b = await open({ autoPong: false });
    b.ws.send(JSON.stringify({ t: 'join', room: code, name: '乙', token: 'net-b' }));
    b.ws.on('message', () => {}); // 只收不回
    // 乙会一直收到快照（服务器在发），但不回 pong：只看 ping/pong，不看服务器发了多少
    await sleep(1200);
    check(b.closed, '不回应心跳的连接在几次 ping 之后被断开');
    check(!a.closed, '正常的连接不受影响');
    await sleep(100);
    const last = a.states[a.states.length - 1];
    const bp = last.players.find((p) => p.name === '乙');
    check(!bp || bp.connected === false, '  被断开的玩家显示为掉线（比赛中由机器人托管）');
    a.ws.close();
  } finally {
    srv.kill();
  }
  done();
})();
