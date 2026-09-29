// 游戏常量（服务端各模块共用）
module.exports = {
  TICK_RATE: 60,
  SEND_RATE: 30,
  PLAYER_R: 24,
  MOVE_SPEED_MUL: 1, // 整体移速倍率。v2.6 修好 Windows 上主循环只跑 36Hz 的问题后，游戏已经比以前快了约 1.67 倍，这里先不再额外加速
  STEER_GRIP: 6, // 转向时横向速度每秒衰减的比例（越大转弯越"跟手"）
  STEER_BRAKE: 900, // 掉头时额外的刹车加速度
  DASH_IMPULSE: 680,
  DASH_COOLDOWN: 1.2,
  // 跳跃：服务器权威的离地高度 z / 竖直速度 vz。起跳速度和重力决定滞空约 0.68 秒、最高约 91（角色直径 48，能从别人头上越过去）
  GRAVITY: 1600,
  JUMP_V: 540,
  JUMP_BUFFER: 0.12, // 落地前 0.12 秒内按的跳也算（不用卡准落地那一帧）
  JUMP_COYOTE: 0.1, // 刚走出地面边缘 / 脚下地砖刚塌的 0.1 秒内还能起跳
  // 落地硬直：落地后 0.22 秒内不能再起跳（这期间按的跳会留着，硬直一过就跳）；
  // 落地 0.4 秒内接着跳的是"连跳"，保持较低高度（最高 ≈47，越不过别人头顶）。
  // 不然一直按跳的人 98% 的时间都在空中，谁都撞不到他，还能一直踩别人的头
  JUMP_RECOVER: 0.22,
  JUMP_TIRED: 0.4,
  JUMP_TIRED_V: 0.72,
  AIR_ACCEL: 0.8, // 空中的加速度和阻尼都打八折：极速不变，但转向、刹车更慢（空中操控弱一些）
  AIR_DAMPING: 0.8,
  AIR_GRIP: 0.3, // 空中转向抓地力只有地面的 30%
  STOMP_BOUNCE: 360, // 踩到别人头上时自己弹起来的速度
  STOMP_PUSH: 240, // 被踩的人被轻轻挤开的速度（不会直接被踩下场）
  STOMP_COOLDOWN: 0.6, // 同一个人被踩后多久才能再被踩
  STOMP_CHAIN: 2, // 一次腾空最多踩几个头（人堆里不能一路踩着别人的头飞好几秒），第二下弹得低一些
  RESTITUTION: 1.7, // >1 让碰撞更"弹"，更有乐趣
  COUNTDOWN: 3,
  ROUND_END_DELAY: 3.5,
  KO_WINDOW: 3, // 被撞后几秒内掉下去算对方击飞
  MAX_PLAYERS: 8,
  STRONG_HIT: 260, // 超过这个相对速度算一次"重击"

  ITEM_TYPES: ['big', 'speed', 'shield', 'bomb', 'freeze', 'ghost', 'tornado', 'banana'],
  ITEM_DURATION: { big: 7, speed: 6, shield: 6, ghost: 5 },
  ITEM_MAX: 4,
  ITEM_R: 20,
  BOMB_RADIUS: 190,
  BOMB_POWER: 900,
  FREEZE_RADIUS: 250,
  FREEZE_TIME: 2,
  SLIP_TIME: 1.3,

  LOBBY_DC_GRACE: 10, // 大厅里掉线多少秒后移出房间
  HOST_DC_GRACE: 6, // 房主掉线多少秒后自动换房主
  GAME_DC_GRACE: 60, // 游戏中掉线多少秒后移出（期间由机器人托管）
  CHAT_MAX: 50,
  EMOTE_COUNT: 8,

  BOT_NAMES: ['铁头', '弹弹', '旋风', '小胖', '闪电', '豆豆', '滚滚', '阿呆', '咕咕', '团子'],
  BOT_NAMES_EN: ['Bonk', 'Boing', 'Twister', 'Chunky', 'Zap', 'Bean', 'Rolly', 'Dizzy', 'Coco', 'Mochi'],
  // 机器人难度：思考间隔、冲刺概率、瞄准误差、安全意识
  BOT_LEVELS: [
    { think: 0.28, dash: 0.25, noise: 0.8, safety: 45 },
    { think: 0.14, dash: 0.45, noise: 0.4, safety: 70 },
    { think: 0.08, dash: 0.6, noise: 0.2, safety: 90 },
  ],
};
