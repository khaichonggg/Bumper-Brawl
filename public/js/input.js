// 输入：键盘 + 鼠标 + 手机虚拟摇杆 / 按钮
//   移动 WASD / 方向键　跳 空格　冲刺 鼠标右键（Shift / K 也行）　技能 Q / 鼠标左键
//   第一人称：鼠标（锁定后直接移动，没锁定时按住拖动）/ 手机右半屏拖动 转视角，上下左右都能看；←→ 键左右转
// 冲刺 / 跳 / 技能都是"按下一次算一次"，攒到下一条输入消息里发给服务器
const keys = new Set();
let dashQueued = false;
let jumpQueued = false;
let skillQueued = false;
const touchDir = { x: 0, y: 0 };
let lookDX = 0; // 第一人称：鼠标 / 右半屏拖动累计的转向量（像素）
let lookDY = 0;
let fpMode = () => false;
let active = () => false; // 当前是否在操控角色（由 main.js 设置）
let inGame = () => false; // 是否在比赛画面（右键菜单在这时屏蔽）

const typing = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
const onCanvas = (e) => !!e.target && e.target.id === 'game';

window.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  keys.add(e.code);
  if (!active()) return;
  if (e.code === 'Space') {
    // 按住不放不会连跳：只认第一次按下（落地前按也行，服务器会先存 0.12 秒）
    if (!e.repeat) jumpQueued = true;
    e.preventDefault();
    // 刚点过的按钮还有焦点时，空格会"点"它一下（比如切换视角），先把焦点拿掉
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
  }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyK') {
    dashQueued = true;
    e.preventDefault();
  }
  if (e.code === 'KeyQ' && !e.repeat) skillQueued = true;
  if (e.code.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// 摇杆：左半屏任意位置按下即出现
const stick = document.getElementById('stick');
const knob = document.getElementById('knob');
let stickTouch = null;
let origin = null;
const STICK_MAX = 50;

function resetStick() {
  stickTouch = null;
  touchDir.x = touchDir.y = 0;
  knob.style.transform = '';
  stick.style.left = '';
  stick.style.top = '';
  stick.style.bottom = '';
}

// 第一人称：右半屏按住拖动转视角（左右 + 上下）
let lookTouch = null;
let lookX = 0;
let lookY = 0;
const TOUCH_LOOK = 1.6; // 手指拖动比鼠标转得快一些（屏幕小）
window.addEventListener(
  'touchstart',
  (e) => {
    if (!active()) return;
    for (const t of e.changedTouches) {
      if (t.target.closest && t.target.closest('button, .hud-buttons, .emote-picker, .modal')) continue;
      if (t.clientX >= window.innerWidth * 0.55 && lookTouch === null && fpMode()) {
        lookTouch = t.identifier;
        lookX = t.clientX;
        lookY = t.clientY;
        continue;
      }
      if (t.clientX < window.innerWidth * 0.55 && stickTouch === null) {
        stickTouch = t.identifier;
        origin = { x: t.clientX, y: t.clientY };
        stick.style.left = t.clientX - 65 + 'px';
        stick.style.top = t.clientY - 65 + 'px';
        stick.style.bottom = 'auto';
      }
    }
  },
  { passive: true }
);
window.addEventListener(
  'touchmove',
  (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === lookTouch) {
        lookDX += (t.clientX - lookX) * TOUCH_LOOK;
        lookDY += (t.clientY - lookY) * TOUCH_LOOK;
        lookX = t.clientX;
        lookY = t.clientY;
        continue;
      }
      if (t.identifier !== stickTouch) continue;
      let dx = t.clientX - origin.x;
      let dy = t.clientY - origin.y;
      const d = Math.hypot(dx, dy);
      if (d > STICK_MAX) {
        dx = (dx / d) * STICK_MAX;
        dy = (dy / d) * STICK_MAX;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      touchDir.x = dx / STICK_MAX;
      touchDir.y = dy / STICK_MAX;
    }
  },
  { passive: true }
);
const endTouch = (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === stickTouch) resetStick();
    if (t.identifier === lookTouch) lookTouch = null;
  }
};
window.addEventListener('touchend', endTouch);
window.addEventListener('touchcancel', endTouch);

// 鼠标：比赛中在画面上（或鼠标已锁定时）右键 = 冲刺，左键 = 技能。
// 第一人称还没锁定鼠标时，左键这一下是用来锁定鼠标的（main.js 里请求锁定），按住拖动也能转视角，不放技能
let dragLook = false;
window.addEventListener('mousedown', (e) => {
  const locked = !!document.pointerLockElement;
  if (!active() || !(locked || onCanvas(e))) return;
  if (e.button === 2) {
    dashQueued = true;
    e.preventDefault();
  } else if (e.button === 0) {
    if (fpMode() && !locked) dragLook = true;
    else skillQueued = true;
  }
});
window.addEventListener('mouseup', () => (dragLook = false));
window.addEventListener('mousemove', (e) => {
  if (!fpMode()) return;
  if (document.pointerLockElement || (dragLook && e.buttons)) {
    lookDX += e.movementX;
    lookDY += e.movementY;
  }
});
// 比赛画面上屏蔽右键菜单（右键是冲刺）
window.addEventListener('contextmenu', (e) => {
  if ((onCanvas(e) || document.pointerLockElement) && inGame()) e.preventDefault();
});

// 手机按钮：按下就触发（不等抬起），顺便震一下
function touchButton(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (el.disabled) return;
      fn();
      if (navigator.vibrate) navigator.vibrate(15);
    },
    { passive: false }
  );
  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    if (!el.disabled) fn();
  });
}
touchButton('dashBtn', () => (dashQueued = true));
touchButton('jumpBtn', () => (jumpQueued = true));
touchButton('skillBtn', () => (skillQueued = true));

const take = (v, clear) => {
  clear();
  return v;
};

export const input = {
  setActive(fn) {
    active = fn;
  },
  setInGame(fn) {
    inGame = fn;
  },
  setFirstPerson(fn) {
    fpMode = fn;
  },
  // 第一人称转向：返回 [-1,1] 的键盘转向（←→）+ 鼠标 / 拖动的横向、纵向像素
  takeTurn() {
    let k = 0;
    if (keys.has('ArrowLeft')) k -= 1;
    if (keys.has('ArrowRight')) k += 1;
    const px = lookDX;
    const py = lookDY;
    lookDX = lookDY = 0;
    return { keys: k, px, py };
  },
  // fp=true 时方向键左右用来转向，不再左右平移
  read(fp = false) {
    let x = 0;
    let y = 0;
    if (keys.has('KeyA') || (!fp && keys.has('ArrowLeft'))) x -= 1;
    if (keys.has('KeyD') || (!fp && keys.has('ArrowRight'))) x += 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
    x += touchDir.x;
    y += touchDir.y;
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    return { x, y };
  },
  takeDash: () => take(dashQueued, () => (dashQueued = false)),
  takeJump: () => take(jumpQueued, () => (jumpQueued = false)),
  takeSkill: () => take(skillQueued, () => (skillQueued = false)),
  reset() {
    keys.clear();
    dashQueued = jumpQueued = skillQueued = false;
    lookDX = lookDY = 0;
    lookTouch = null;
    dragLook = false;
    resetStick();
  },
};
