// 渲染核心：渲染器、场景、相机、灯光、天空、液面、画质
import * as THREE from 'three';
import { EffectComposer } from '../../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from '../../vendor/addons/environments/RoomEnvironment.js';
import { settings, isTouch } from '../settings.js';
import { t as tr } from '../i18n.js';
import { suggestTier } from './gputier.js';

export const LIQUID_Y = -150;
export const TILE_H = 26;

export const canvas = document.getElementById('game');
export let renderer;
try {
  // 画布本身不开抗锯齿：画面先画到带多重采样的离屏图里（见下面的 composer），画布只接收最后一步，开了白占显存
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch {
  // 最常见的原因不是浏览器太旧：显卡驱动崩溃几次后，Chrome 会自动关掉 3D 加速（chrome://gpu 里显示 WebGL: Disabled），重启浏览器就好
  document.getElementById('loading').innerHTML = '<div class="gl-help">' + tr('<b>3D 画面打不开（WebGL 被关闭了）</b><br>通常是显卡驱动出过错，浏览器自动关掉了 3D 加速。<br>① 在地址栏输入 <code>chrome://restart</code> 回车，重启浏览器<br>② 还不行：浏览器设置 → 系统 → 打开「使用图形加速」<br>③ 仍然不行：更新显卡驱动，再重启电脑') + '</div>';
  throw new Error('WebGL unavailable');
}
// 阴影贴图一直开着：开关它会让所有材质换一套 shader 重新编译（"低"画质用别的办法去掉阴影，见 applyShadows）
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

export const scene = new THREE.Scene();
scene.fog = new THREE.Fog('#6a2230', 1500, 4200);
export const camera = new THREE.PerspectiveCamera(45, 1, 10, 12000);

// 环境反射：让塑料、金属、冰面有高光和反光，不再是"平涂"
function makeEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const old = scene.environment;
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.2;
  pmrem.dispose();
  if (old) old.dispose();
}
makeEnvironment();

// 后期：画面始终走同一条管线（场景 → 离屏图 → [泛光] → OutputPass 色调映射）。
// 以前"高"走这条、"中 / 低"直接画到屏幕：两种走法的 shader 不一样，换画质就要把整个场景的 shader 重编一遍。
// 现在只有泛光是个开关（岩浆、火花、道具、发光皮肤会发光）。
const gl = renderer.getContext();
const floatRT = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
// 有的手机显卡不支持"半精度 + 多重采样"：查一下这种格式最多能开几倍抗锯齿，开多了离屏图会建不出来（黑屏）
const MAX_SAMPLES = (() => {
  try {
    const fmt = floatRT ? gl.RGBA16F : gl.RGBA8;
    const list = gl.getInternalformatParameter(gl.RENDERBUFFER, fmt, gl.SAMPLES);
    return list && list.length ? Math.max(...list) : 0;
  } catch {
    return 0; // WebGL1 / 查询失败：不开
  }
})();
const sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: floatRT ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: Math.min(4, MAX_SAMPLES) });
const composer = new EffectComposer(renderer, sceneRT);
composer.addPass(new RenderPass(scene, camera));
export const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.45, 1.6);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// 泛光本来就是糊的：在一半分辨率上算，省掉四分之三的像素
const BLOOM_SCALE = 0.5;
{
  const setBloomSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => setBloomSize(Math.max(2, Math.round(w * BLOOM_SCALE)), Math.max(2, Math.round(h * BLOOM_SCALE)));
}
bloom.enabled = false;

let frameNo = 0;
let shadowEvery = 1;
let rendered = 0;
export function render() {
  // 场景里有 shader 正在后台编译（开机、换地图）：这一帧先不画，屏幕上保持上一帧，界面照常能点
  if (holds.size) return;
  frameNo++;
  // 中画质：阴影每两帧更新一次（阴影那一遍要把所有投影的物体再画一次）
  if (shadowEvery > 1 && frameNo % shadowEvery === 0) renderer.shadowMap.needsUpdate = true;
  composer.render();
  rendered++;
  if (collapseShadow) {
    collapseShadow = false;
    collapseShadowCamera();
  }
}
/** 画过至少一帧了吗（开机时编译完 shader 才画第一帧，加载画面等到那时再关） */
export const hasRendered = () => rendered > 0;

export const hemi = new THREE.HemisphereLight('#9fb0ff', '#ff6a2a', 0.9);
scene.add(hemi);
export const sun = new THREE.DirectionalLight('#fff0dc', 2.6);
sun.position.set(300, 800, 380);
sun.castShadow = true;
Object.assign(sun.shadow.camera, { left: -600, right: 600, top: 600, bottom: -600, near: 100, far: 2000 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 1.5;
scene.add(sun);
// 从下方照亮浮岛（岩浆 / 海水 / 星球的反光）
export const underLight = new THREE.PointLight('#ff5a1a', 3.5, 1400, 0);
underLight.position.set(0, LIQUID_Y + 30, 0);
scene.add(underLight);

// ---------------------------------------------------------------------
// 画质：高 / 中 / 低
// ---------------------------------------------------------------------
// 以前换画质会把所有材质标记 needsUpdate、开关阴影贴图、开关泛光管线，每种组合都是另一套 shader。
// Windows 上的 Chrome 把 WebGL 翻译成 Direct3D，编译很慢：KC 的 GTX 650 上实测每次同步重编 16-17 个 shader，
// 画面整整卡住 2.5-2.8 秒，连着点几下就一直卡着。
// 现在换画质只改不影响 shader 的东西：分辨率、抗锯齿采样数、阴影贴图大小 / 强度 / 更新频率、泛光开关。
// 阴影的 shader 永远是"带阴影"那一套（"低"画质靠缩小阴影范围把开销去掉，见 applyShadows），
// 泛光的几个 shader 开机后在后台编好，所以任何两档之间切换都不用重新编译。
const TIERS = {
  high: { pr: 2, samples: 4, shadow: isTouch ? 1024 : 2048, shadowEvery: 1, bloom: true, particles: 1 },
  medium: { pr: 1.25, samples: 2, shadow: 1024, shadowEvery: 2, bloom: false, particles: 0.7 }, // 半精度离屏图上 4 倍抗锯齿在老显卡上很贵，2 倍便宜得多
  low: { pr: 1, samples: 0, shadow: 0, shadowEvery: 0, bloom: false, particles: 0.4 },
};
const RANK = { low: 0, medium: 1, high: 2 };
export const quality = { particles: 1, tier: 'high' };

// 显卡型号 → 建议的起始画质（玩家手动选过画质就不管）
export const gpuName = (() => {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || '');
  } catch {
    return '';
  }
})();
if (settings.autoQuality !== false) {
  const s = suggestTier(gpuName);
  if (s && RANK[s] < (RANK[settings.quality] ?? 2)) settings.quality = s;
}

let bloomReady = false;
let bloomWarm = null;
let bloomJob = null;
let applyToken = 0;
const busy = new Set();
const holds = new Set();

// 右下角的小提示：正在后台编译 shader / 画面在恢复
let busyEl = null;
let busyText = '';
function setBusy(key, on, text) {
  if (on) busy.add(key);
  else busy.delete(key);
  if (text) busyText = text;
  if (!busyEl) {
    busyEl = document.createElement('div');
    busyEl.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:90;padding:6px 12px;border-radius:12px;background:rgba(20,14,40,.82);color:#ffe066;font:700 13px/1.4 system-ui,sans-serif;pointer-events:none;opacity:0;transition:opacity .2s';
    document.body.appendChild(busyEl);
  }
  busyEl.textContent = busy.has('lost') ? busyText : tr('正在切换画质…');
  busyEl.style.opacity = busy.size ? '1' : '0';
}
/** 还有画质相关的 shader 在后台编译吗（测试用） */
export const qualityPending = () => busy.size > 0;

// ---------------------------------------------------------------------
// 后台编译 shader
// ---------------------------------------------------------------------
// three.js 默认在物体第一次出现在画面上时才编译它的 shader，而且是同步的：Windows 的 Chrome 上一个要 100-300ms，
// 比赛中第一次出现道具 / 龙卷风 / 幽灵效果时画面会突然卡一下（实测一次 750ms）。
// 有 KHR_parallel_shader_compile 时（Windows / 安卓的 Chrome 都有）可以让浏览器在后台线程编译，画面照常。
// 注意编译时的"状态"必须和真正渲染时一致（画到离屏图、同样的灯光 / 雾 / 环境贴图），否则编出来的是另一个版本。
export const parallelCompile = !!gl.getExtension('KHR_parallel_shader_compile');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const programOf = (m) => renderer.properties.get(m).currentProgram;
function compileNow(root, target) {
  const prevRT = renderer.getRenderTarget();
  renderer.setRenderTarget(composer.renderTarget1); // 按"画到离屏图"的方式编译，和真正渲染时一致
  try {
    return renderer.compile(root, camera, target);
  } finally {
    renderer.setRenderTarget(prevRT);
  }
}

/**
 * 在后台编译若干物体（连同子物体）里所有材质的 shader。
 * @param {THREE.Object3D[]} roots 要编译的物体（可以不在场景里）
 * @param {object} [o]
 * @param {THREE.Object3D} [o.target] 它们真正渲染时所在的场景：灯光、雾、环境贴图都会影响 shader 版本
 * @param {number} [o.inFlight] 同时最多编译几个。编译很吃 CPU（4 核的电脑一次丢 18 个进去，画面顿了将近 1 秒），
 *   后台慢慢编的时候一次只放一两个
 * @param {number} [o.timeout] 最多等多久（毫秒），驱动出怪问题时别一直等下去
 * @param {boolean} [o.onlyNew] 只编译还没编译过的材质（换地图时整个场景过一遍要 25ms，只看新加的东西几毫秒）
 * @returns {Promise<{ materials: Set<THREE.Material>, fresh: number }>} fresh = 新编译的 shader 数
 */
export async function precompile(roots, { target = scene, inFlight = Infinity, timeout = 15000, onlyNew = false } = {}) {
  const t0 = performance.now();
  if (onlyNew) roots = uncompiled(roots);
  const materials = new Set();
  let waiting = [];
  let fresh = 0;
  const known = new Set(renderer.info.programs);
  const settle = async (limit) => {
    if (!parallelCompile) {
      // 没有并行编译扩展时 isReady() 总是 true，真正的编译发生在下一帧用到时（同步）：每编几个就隔几帧，把卡顿分散开
      if (waiting.length < limit) return;
      waiting = [];
      for (let i = 0; i < 4; i++) await nextFrame();
      return;
    }
    while (waiting.length >= limit && performance.now() - t0 < timeout) {
      await nextFrame();
      waiting = waiting.filter((p) => !p.isReady());
    }
  };
  for (const root of roots) {
    for (const m of compileNow(root, target)) {
      materials.add(m);
      const p = programOf(m);
      if (!p || known.has(p)) continue;
      known.add(p);
      fresh++;
      if (!parallelCompile || !p.isReady()) waiting.push(p);
    }
    await settle(inFlight);
  }
  await settle(1);
  return { materials, fresh };
}

// 找出材质还没编译过的物体（它们的子物体会跟着一起编译，这里不用再单独列）
function uncompiled(roots) {
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    root.traverse((o) => {
      if (!o.material || !(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      let fresh = false;
      for (const m of ms) {
        if (seen.has(m)) continue;
        seen.add(m);
        if (!programOf(m)) fresh = true;
      }
      if (fresh) out.push(o);
    });
  }
  return out;
}

/**
 * 在 promise 完成前先不画新的一帧（最多 maxMs 毫秒）。
 * 用于开机、换地图：一大批 shader 并行编译比一帧里同步编译快得多，而且这期间界面不会卡死。
 */
export function holdRender(promise, maxMs = 6000) {
  if (!parallelCompile) return promise; // 没法后台编译：还是边画边编
  const key = {};
  holds.add(key);
  const release = () => holds.delete(key);
  const timer = setTimeout(release, maxMs);
  return Promise.resolve(promise)
    .catch((e) => console.warn('precompile', e))
    .finally(() => {
      clearTimeout(timer);
      release();
    });
}

// 泛光的几个 shader：一个全屏三角形挂上它的各个材质（不在主场景里，没有灯光和雾，和真正渲染时一样）。
// 几何体也要和后期处理用的一样只有 position + uv（有没有法线会编出不同的 shader）
function bloomScene() {
  if (bloomWarm) return bloomWarm;
  bloomWarm = new THREE.Scene();
  const quad = new THREE.BufferGeometry();
  quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  for (const m of [bloom.materialHighPassFilter, ...bloom.separableBlurMaterials, bloom.compositeMaterial, bloom.blendMaterial]) bloomWarm.add(new THREE.Mesh(quad, m));
  return bloomWarm;
}
/** 在后台把泛光的 shader 编好（开机后空闲时调用，之后切到"高"画质就不用等） */
export function warmBloom(inFlight = 2) {
  if (!bloomJob) {
    const w = bloomScene();
    bloomJob = precompile([w], { target: w, inFlight }).then(
      () => {
        bloomReady = true;
      },
      (e) => {
        bloomJob = null; // 下次再试
        throw e;
      }
    );
  }
  return bloomJob;
}

function setShadowSize(size) {
  if (sun.shadow.mapSize.x === size) return;
  sun.shadow.mapSize.set(size, size);
  if (sun.shadow.map) {
    sun.shadow.map.dispose();
    sun.shadow.map = null;
  }
}

// 阴影：开 / 关都不换 shader（sun.castShadow 一直是 true，不然所有受光材质都要换一套 shader）。
// "低"画质：阴影强度 0，阴影贴图缩到很小、只画一次，阴影相机的远平面拉到光源跟前——
// 所有像素都在阴影范围外，shader 里的阴影采样直接跳过，开销几乎为零，也省掉了每帧把所有物体再画一遍的阴影绘制。
const SHADOW_FAR = sun.shadow.camera.far;
let collapseShadow = false;
function setShadowFar(far) {
  const cam = sun.shadow.camera;
  if (cam.far === far) return;
  cam.far = far;
  cam.updateProjectionMatrix();
}
function collapseShadowCamera() {
  setShadowFar(sun.shadow.camera.near + 1);
  renderer.shadowMap.needsUpdate = true;
}
function applyShadows(t) {
  const on = t.shadow > 0;
  setShadowSize(on ? t.shadow : 16);
  sun.shadow.intensity = on ? 1 : 0;
  shadowEvery = on ? t.shadowEvery : 0;
  renderer.shadowMap.autoUpdate = on && shadowEvery <= 1;
  renderer.shadowMap.needsUpdate = true; // 按新设置至少画一次
  collapseShadow = false;
  if (on) setShadowFar(SHADOW_FAR);
  // 开局就是"低"：第一帧还按正常范围画一次阴影贴图，让画阴影用的 shader 先编好（以后切到"中 / 高"时不用再编），下一帧再缩掉
  else if (rendered) collapseShadowCamera();
  else collapseShadow = true;
}

// 泛光：shader 还没编好（开机后几秒内就切到"高"）就先在后台编，编好再打开
function applyBloom(t, token) {
  if (!t.bloom || bloomReady) {
    bloom.enabled = !!t.bloom;
    return;
  }
  bloom.enabled = false;
  const hint = rendered > 0; // 开机时不用提示（加载画面还在）
  if (hint) setBusy('bloom', true);
  warmBloom(Infinity)
    .then(() => {
      if (token === applyToken) bloom.enabled = true; // 编译期间玩家又换了画质：按最新的来
    })
    .catch((e) => console.warn('bloom precompile', e))
    .finally(() => hint && setBusy('bloom', false));
}

function setSamples(n) {
  n = Math.min(n, MAX_SAMPLES);
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
    if (rt.samples === n) continue;
    rt.samples = n;
    rt.dispose(); // 下次用到时按新的采样数重新创建
  }
}

/** 按 settings.quality 应用画质。随时可以调用，不会卡住画面。 */
export function applyQuality() {
  const q = TIERS[settings.quality] ? settings.quality : 'high';
  const t = TIERS[q];
  const token = ++applyToken;
  quality.tier = q;
  quality.particles = t.particles;
  drs.scale = 1;
  drs.ceil = 1;
  drs.bad = drs.good = 0;
  setSamples(t.samples);
  applyShadows(t);
  applyBloom(t, token); // 开机时就是"高"：泛光的 shader 和开机的第一批 shader 一起编译（见 bootCompile）
  resize();
}

/**
 * 开机：先把场景里所有材质（包括还没显示的）并行编译好再画第一帧。
 * 同步编译时画第一帧要卡好几秒、加载画面也不动；并行编译能用上所有 CPU 核，快得多。
 */
export function bootCompile() {
  return holdRender(
    (async () => {
      await precompile([scene], { timeout: 8000 });
      if (bloomJob) await bloomJob;
    })(),
    9000
  );
}

// ---------------------------------------------------------------------
// 动态分辨率：显卡跟不上时自动降低渲染分辨率，恢复了再慢慢升回去（不换 shader，只改画布大小）
// ---------------------------------------------------------------------
const DRS_MIN = 0.6;
const drs = { scale: 1, ceil: 1, ceilUntil: 0, lastChange: 0, sum: 0, cpu: 0, n: 0, winStart: 0, bad: 0, good: 0, gpuBound: true };
/**
 * 每帧调用：rdtMs = 两帧间隔，cpuMs = 这一帧 JS 花的时间。
 * 每秒判断一次：连续 2 秒低于 55 帧、而且不是 JS 太慢，就降分辨率；连续 5 秒稳定在 58 帧以上再一点一点升回去。
 * （以前的门槛是 48 帧：实测 GTX 650 开"高"会停在 53-55 帧上下晃，一直有点卡又不触发下调）
 */
export function adaptResolution(rdtMs, cpuMs) {
  const now = performance.now();
  if (document.hidden || rdtMs > 100 || busy.size) {
    // 切后台 / 卡了一下（编译、加载）：这一段不算
    drs.sum = drs.cpu = drs.n = 0;
    drs.winStart = now;
    return;
  }
  drs.sum += rdtMs;
  drs.cpu += cpuMs;
  drs.n++;
  if (now - drs.winStart < 1000 || drs.n < 10) return;
  const avg = drs.sum / drs.n;
  const cpu = drs.cpu / drs.n;
  drs.sum = drs.cpu = drs.n = 0;
  drs.winStart = now;
  const gpuBound = cpu < avg * 0.6;
  drs.gpuBound = gpuBound;
  drs.bad = avg > 1000 / 55 && gpuBound ? drs.bad + 1 : 0;
  drs.good = avg < 1000 / 58 ? drs.good + 1 : 0;
  let next = drs.scale;
  if (drs.bad >= 2 && drs.scale > DRS_MIN && now - drs.lastChange > 2000) {
    // 按帧时间估算要少画多少像素（像素数 ∝ scale²），一次最多降 25%
    next = Math.max(DRS_MIN, drs.scale * Math.max(0.75, Math.sqrt(16.7 / avg)));
    drs.ceil = drs.scale - 0.05; // 刚才这个分辨率跑不动：半分钟内别再升回去
    drs.ceilUntil = now + 30000;
  } else if (drs.good >= 5 && drs.scale < 1 && now - drs.lastChange > 5000) {
    next = Math.min(1, drs.scale + 0.05, now < drs.ceilUntil ? drs.ceil : 1);
  }
  if (Math.abs(next - drs.scale) < 0.02) return;
  drs.scale = next;
  drs.lastChange = now;
  drs.bad = drs.good = 0;
  resize();
}
/** 降分辨率还能解决卡顿吗：没降到底、而且卡在显卡上（JS 太慢时降分辨率没用，要降档位） */
export const resolutionCanHelp = () => drs.scale > DRS_MIN + 0.01 && drs.gpuBound;
/** 调试 / 测量用 */
export const qualityInfo = () => ({ tier: quality.tier, scale: Math.round(drs.scale * 100) / 100, pr: renderer.getPixelRatio(), samples: composer.renderTarget1.samples, maxSamples: MAX_SAMPLES, bloom: bloom.enabled, bloomReady, shadowEvery, busy: [...busy], holds: holds.size, gpu: gpuName, parallelCompile, programs: renderer.info.programs.length });

// ---------------------------------------------------------------------
// 显卡驱动重置 / 浏览器 GPU 进程崩溃：WebGL 上下文丢了。three.js 会自动恢复，这里补上离屏生成的环境贴图
// ---------------------------------------------------------------------
let lostTimer = null;
canvas.addEventListener('webglcontextlost', () => {
  setBusy('lost', true, tr('画面重新加载中…'));
  // 一直恢复不了（浏览器把 WebGL 禁用了）：只能刷新页面
  clearTimeout(lostTimer);
  lostTimer = setTimeout(() => {
    if (!busy.has('lost')) return;
    setBusy('lost', true, tr('画面出错了，点这里刷新页面'));
    busyEl.style.pointerEvents = 'auto';
    busyEl.style.cursor = 'pointer';
    busyEl.onclick = () => location.reload();
  }, 6000);
});
canvas.addEventListener('webglcontextrestored', () => {
  clearTimeout(lostTimer);
  makeEnvironment();
  renderer.shadowMap.needsUpdate = true;
  if (busyEl) {
    busyEl.style.pointerEvents = 'none';
    busyEl.onclick = null;
  }
  setBusy('lost', false);
});

// ---- 天空 ----
export const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: {
    uTop: { value: new THREE.Color('#0d0820') },
    uMid: { value: new THREE.Color('#3a1240') },
    uHorizon: { value: new THREE.Color('#6a2230') },
    uStars: { value: 0.8 },
    uTime: { value: 0 },
  },
  vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHorizon; uniform float uStars; uniform float uTime; varying vec3 vDir;
    float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }
    void main(){
      float h = vDir.y;
      vec3 col = mix(uHorizon, uMid, smoothstep(-0.05, 0.25, h));
      col = mix(col, uTop, smoothstep(0.2, 0.7, h));
      vec3 cell = floor(vDir * 320.0);
      float r = hash(cell);
      float tw = 0.6 + 0.4 * sin(uTime * 2.0 + r * 40.0);
      float star = step(1.0 - 0.004 * uStars, r) * smoothstep(-0.6, 0.3, h) * tw;
      col += vec3(star) * 0.9;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(10000, 32, 16), skyMat));

// ---- 液面（岩浆 / 海水 / 草莓牛奶，程序化噪声） ----
export const liquidMat = new THREE.ShaderMaterial({
  fog: true,
  uniforms: THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uA: { value: new THREE.Color() },
      uB: { value: new THREE.Color() },
      uC: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uMode: { value: 0 },
      uBoost: { value: 1 },
    },
  ]),
  vertexShader: `
    #include <fog_pars_vertex>
    varying vec3 vWorld;
    void main(){
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: `
    #include <fog_pars_fragment>
    uniform float uTime; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform vec3 uGlow; uniform float uMode; uniform float uBoost;
    varying vec3 vWorld;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      vec2 u = f*f*(3.0-2.0*f);
      return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
    }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; for(int i=0;i<4;i++){ v += a*noise(p); p *= 2.03; a *= 0.5; } return v; }
    void main(){
      vec2 p = vWorld.xz * 0.005;
      float t = uTime * 0.06;
      vec2 q = vec2(fbm(p + vec2(t, 0.0)), fbm(p + vec2(3.1, -t)));
      float n = fbm(p * 1.6 + q * 2.2 + vec2(t * 1.4, -t));
      vec3 col;
      if (uMode < 0.5) {
        float glow = 1.0 - smoothstep(0.3, 0.47, n);
        vec3 dark = uA * (0.7 + 0.6 * noise(p * 18.0));
        col = mix(dark, uB, glow);
        col = mix(col, uC * uBoost, glow * glow * glow);
        col *= 0.85 + 0.15 * sin(uTime * 1.5 + n * 10.0);
      } else if (uMode < 1.5) {
        col = mix(uA, uB, smoothstep(0.3, 0.7, n));
        float floe = smoothstep(0.62, 0.66, fbm(p * 2.5 + vec2(t * 0.4, 1.7)));
        col = mix(col, uC, floe * 0.85);
        float sparkle = pow(max(0.0, noise(p * 70.0 + uTime * 0.4) - 0.82) * 5.5, 3.0);
        col += sparkle * 0.5;
      } else {
        float s = sin((p.x * 0.7 + p.y) * 7.0 + n * 9.0 + uTime * 0.25);
        col = mix(uA, uB, smoothstep(-0.4, 0.4, s));
        col = mix(col, uC, smoothstep(0.62, 0.72, n) * 0.5);
      }
      float d = length(vWorld.xz);
      col += uGlow * smoothstep(800.0, 300.0, d) * 0.35;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`,
});
export const liquid = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000), liquidMat);
liquid.rotation.x = -Math.PI / 2;
liquid.position.y = LIQUID_Y;
scene.add(liquid);

// ---- 通用小工具 ----
export const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...o });
export function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
// 用确定性噪声扰动顶点，做出低多边形岩石
export function rockify(geo, amount, seed = 1) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = Math.sin(x * 0.11 + seed) * Math.cos(z * 0.13 + seed * 2) + Math.sin(y * 0.17 + seed * 3);
    const k = 1 + n * amount;
    pos.setXYZ(i, x * k, y + n * amount * 20, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}
const shared = new WeakSet();
export const markShared = (x) => (shared.add(x), x);
export function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose();
    if (o.material) {
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        if (shared.has(m)) return;
        if (m.map && !shared.has(m.map)) m.map.dispose();
        m.dispose();
      });
    }
  });
  g.clear();
}

// 文字贴图精灵（名字、漫画字、表情气泡）
export function textSprite(text, { color = '#ffffff', size = 40, stroke = 'rgba(20,14,40,0.85)', height = 16, bg = null } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `900 ${size}px -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI Emoji", sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + size * 0.6;
  const h = Math.ceil(size * 1.4);
  c.width = w;
  c.height = h;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (bg) {
    ctx.fillStyle = bg;
    const r = h / 2;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(w, 0, w, h, r);
    ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r);
    ctx.arcTo(0, 0, w, 0, r);
    ctx.fill();
  }
  if (stroke) {
    ctx.lineWidth = size / 5;
    ctx.strokeStyle = stroke;
    ctx.strokeText(text, w / 2, h / 2 + 1);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set((w / h) * height, height, 1);
  s.renderOrder = 10;
  return s;
}

export function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // 渲染分辨率 = min(屏幕像素比, 画质上限) × 动态分辨率
  const t = TIERS[quality.tier] || TIERS.high;
  const pr = Math.max(0.5, Math.min(window.devicePixelRatio || 1, t.pr) * drs.scale);
  if (Math.abs(renderer.getPixelRatio() - pr) > 0.001) renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  for (const fn of resizeHooks) fn();
}
const resizeHooks = [];
export const onResize = (fn) => resizeHooks.push(fn);
window.addEventListener('resize', resize);
