// 按显卡型号建议起始画质（玩家没手动选过画质时才用）。
// 名字来自 WEBGL_debug_renderer_info，Windows 上的 Chrome 会写成
// "ANGLE (NVIDIA, NVIDIA GeForce GTX 650 (0x00000FC6) Direct3D11 vs_5_0 ps_5_0, D3D11)" 这种格式。
// 纯函数、没有依赖：测试里可以直接 import。

// 软件渲染 / 很老的集成显卡 / 入门级手机芯片：直接从"低"开始
const LOW = [
  /swiftshader|llvmpipe|softpipe|software|basic render/,
  /intel.*gma/,
  /intel.*hd graphics(?! [5-9]\d{2,3})/, // HD Graphics / 2000 / 3000 / 4000 / 4600 ……（Haswell 及更早）
  /geforce\s*(gt|gts)?\s*[1-3]\d{2}\b/, // GeForce 8/9/100-300 系列（名字里是三位数的老卡）
  /geforce\s*gt\s*\d{3}\b/, // GT 610 / 630 / 710 / 730 这类入门卡
  /radeon\s*hd\s*[2-6]\d{3}\b/,
  /mali-(4\d\d|t[6-8]\d\d|g31|g51|g52)\b/,
  /adreno\D*(2\d\d|3\d\d|4\d\d|50\d|51\d)\b/,
  /powervr|videocore|vivante/,
];
// 十年左右的独显 / 较新的集成显卡 / 中端手机：从"中"开始
const MEDIUM = [
  /geforce\s*gtx\s*[4-7]\d{2}\b/, // GTX 4xx-7xx（Fermi / Kepler，比如 KC 的 GTX 650）
  /geforce\s*(mx\s*\d{3}|gt\s*1030)\b/,
  /quadro\s*(k|fx|nvs)/,
  /radeon\s*(hd\s*[7-8]\d{3}|r[5-7]\s)/,
  /radeon.*vega\s*[3-8]\b/,
  /intel.*(hd graphics [5-9]\d{2,3}|uhd|iris)/,
  /mali-g(57|68|71|72|76)\b/,
  /adreno\D*(5[2-4]\d|6[0-2]\d)\b/,
];

/**
 * 根据显卡名字建议起始画质。
 * @param {string} name 显卡名字（WEBGL_debug_renderer_info）
 * @returns {'low'|'medium'|null} null = 看不出来 / 显卡够好，用默认画质
 */
export function suggestTier(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  if (LOW.some((re) => re.test(n))) return 'low';
  if (MEDIUM.some((re) => re.test(n))) return 'medium';
  return null;
}
