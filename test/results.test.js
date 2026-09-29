// 结算和权限：涂色大战并列第一算平局（排行榜谁都不记胜）；被踢的人旧连接发来的消息房间一律不理
const { makeRoom, FakeWS, check, done } = require('./helpers');
const { MODES } = require('../server/modes');
const leaderboard = require('../server/leaderboard');

// 拦住排行榜写入，看每个人记没记胜
let recorded = [];
leaderboard.record = (rows) => recorded.push(...rows);

// 开一局涂色大战，手动摆好每人涂了几块地砖，然后让时间走完
function paintEnding(tilesA, tilesB) {
  const { room, host } = makeRoom();
  room.applySettings({ mode: 'paint' });
  const guest = room.addPlayer({ name: '小红', ws: new FakeWS(), token: 'G' });
  room.startMatch();
  room.phase = 'playing';
  // 两个人都"不在场上"：这一帧不会再涂到脚下的地砖，计数只看下面摆好的
  for (const p of room.list()) p.alive = false;
  room.m.owner.fill(-1);
  const slotA = room.m.slots.indexOf(host.id);
  const slotB = room.m.slots.indexOf(guest.id);
  let i = 0;
  for (let n = 0; n < tilesA; n++) room.m.owner[i++] = slotA;
  for (let n = 0; n < tilesB; n++) room.m.owner[i++] = slotB;
  room.m.clock = 0.001;
  recorded = [];
  MODES.paint.update(room, 1 / 60);
  return { room, host, guest };
}

{
  const { room } = paintEnding(1, 1);
  const r = room.results;
  check(room.phase === 'gameOver' && r && r.winners.length === 0, '涂色大战 1 块对 1 块：平局，没有赢家');
  check(r && r.text === '平局！', '结算写明是平局');
  check(recorded.length === 2 && recorded.every((x) => !x.won), '平局时排行榜两个人都不记胜（以前各记一胜）');
}
{
  const { room, host } = paintEnding(3, 1);
  check(room.results.winners.join() === String(host.id), '涂得多的一方获胜');
  check(recorded.filter((x) => x.won).map((x) => x.name).join() === host.name, '排行榜只给赢家记一胜');
}

// 被踢的人：服务器还没断开他的旧连接时，他发的聊天 / 贴图 / 表情 / 房间操作都不算数
{
  const { room, host } = makeRoom();
  const q = room.addPlayer({ name: '路人', ws: new FakeWS(), token: 'Q' });
  room.handle(host, { t: 'kick', id: q.id });
  check(!room.players.has(q.id), '房主把人踢出房间');
  const chats = room.chatLog.length;
  room.events = [];
  room.handle(q, { t: 'chat', text: '我又回来了' });
  room.handle(q, { t: 'sticker', s: 'lol' });
  room.handle(q, { t: 'emote', i: 1 });
  room.handle(q, { t: 'ready', v: true });
  check(room.chatLog.length === chats, '被踢的人发的聊天和贴图不会进聊天记录');
  check(!room.events.some((e) => e.id === q.id), '被踢的人发的表情 / 贴图不会广播给房间里的人');
  room.handle(host, { t: 'chat', text: '还在吗' });
  check(room.chatLog.length === chats + 1, '房间里的人照常聊天');
}
done();
