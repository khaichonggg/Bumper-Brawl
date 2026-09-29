// 局域网相关的小工具：找本机局域网地址、在控制台打印二维码、打开浏览器
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, execFile } = require('child_process');

// 虚拟网卡（虚拟机、WSL、Docker、VPN）的地址朋友连不上，排到最后
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|vmnet|vboxnet|docker|br-|veth|virbr|utun|tun|tap|ZeroTier|Tailscale|Loopback|Bluetooth|蓝牙|Clash|Mihomo|Meta|wintun|v2ray|xray|sing-?box|WireGuard|OpenVPN|Radmin|Hamachi|VPN|加速/i;
// 按网卡名字判断类型：朋友的手机一定连 Wi-Fi，所以电脑同时连着网线和 Wi-Fi（而且是两个不同的网络）时，
// Wi-Fi 的地址排第一；Windows「移动热点」（本地连接* N，192.168.137.x）是这台电脑自己开的热点
const WIFI = /^(Wi-?Fi|WLAN|无线|wlan\d|wlp|wlx)/i;
const WIRED = /^(Ethernet|以太网|eth\d|enp|eno|ens)/i;
const HOTSPOT_IP = /^192\.168\.137\./;

function privateScore(ip) {
  if (/^192\.168\./.test(ip)) return 3;
  if (/^10\./.test(ip)) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  return 0;
}
function kindOf(iface, ip) {
  if (HOTSPOT_IP.test(ip)) return 'hotspot';
  if (WIFI.test(iface)) return 'wifi';
  if (WIRED.test(iface)) return 'wired';
  return 'other';
}
const KIND_SCORE = { wifi: 7, hotspot: 6, wired: 5, other: 0 };

// 网络名（Wi-Fi 名字 / 网线网络的名字）和 Windows 网络类型（公用 / 专用），要调系统命令，慢，
// 所以后台查、缓存起来；地址列表本身一直是同步、立刻返回的
const meta = { byIface: {}, at: 0, pending: null };
const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (err, out) => resolve(err ? '' : String(out || '')));
  });
// Windows 快速通道：netsh 只要 0.15 秒就能读出 Wi-Fi 名字（PowerShell 冷启动要 2~10 秒）。
// netsh 输出重定向时不管 chcp，一律用系统编码（中文 Windows 是 GBK）：先按 UTF-8 解，有乱码再按 GBK 解。
// 各项的标签随系统语言变（Name / 名称），所以不认标签：每段第一行就是网卡名，SSID 这个词各语言都一样
const runBuf = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, encoding: 'buffer' }, (err, out) => resolve(err ? Buffer.alloc(0) : out));
  });
async function readWifiNames() {
  const buf = await runBuf('netsh', ['wlan', 'show', 'interfaces']);
  let text = buf.toString('utf8');
  if (text.includes('�')) {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch {
      /* 这个 Node 没带 GBK 解码：中文名字会乱，英文名字照样能用 */
    }
  }
  const byIface = {};
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const rows = block.split(/\r?\n/).map((l) => l.match(/^\s{2,}(.+?)\s*:\s(.*)$/)).filter(Boolean);
    const ssid = rows.find((r) => r[1].trim() === 'SSID');
    if (rows.length && ssid && ssid[2].trim()) byIface[rows[0][2].trim()] = { name: ssid[2].trim(), category: '', wifi: true };
  }
  return byIface;
}
async function readMeta() {
  const byIface = {};
  if (process.platform === 'win32') {
    // 先把 Wi-Fi 名字放进缓存（界面马上能用），再等 PowerShell 补上网线网络的名字和公用 / 专用
    const wifi = await readWifiNames();
    meta.byIface = { ...meta.byIface, ...wifi };
    Object.assign(byIface, wifi);
    // 控制台编码改成 UTF-8，不然「以太网」这类中文网卡名传回来是乱码；枚举转成字符串（PS 5.1 默认转成数字）
    const out = await run('powershell', [
      '-NoProfile',
      '-Command',
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-NetConnectionProfile | Select-Object InterfaceAlias,Name,@{n='Category';e={[string]$_.NetworkCategory}} | ConvertTo-Json -Compress",
    ]);
    try {
      const parsed = JSON.parse(out.trim() || '[]');
      for (const p of Array.isArray(parsed) ? parsed : [parsed]) {
        // Wi-Fi 以 netsh 读到的 SSID 为准（网络配置文件名有时会带 " 2" 之类的后缀），这里只补类型
        if (p && p.InterfaceAlias) byIface[p.InterfaceAlias] = { ...byIface[p.InterfaceAlias], name: (byIface[p.InterfaceAlias] || {}).name || String(p.Name || ''), category: String(p.Category || '') };
      }
    } catch {
      /* 查不到网络名也能用，只是界面上不显示名字 */
    }
  } else if (process.platform === 'linux') {
    for (const line of (await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,CONNECTION', 'device'])).split('\n')) {
      const [dev, type, name] = line.split(':');
      if (dev && name && name !== '--') byIface[dev] = { name, category: '', wifi: type === 'wifi' };
    }
  } else if (process.platform === 'darwin') {
    const ports = await run('networksetup', ['-listallhardwareports']);
    for (const m of ports.matchAll(/Hardware Port: (Wi-Fi|AirPort)\s*\nDevice: (\S+)/g)) {
      const name = ((await run('networksetup', ['-getairportnetwork', m[2]])).match(/Network: (.+)/) || [])[1];
      byIface[m[2]] = { name: name ? name.trim() : '', category: '', wifi: true };
    }
  }
  return byIface;
}
/** 后台刷新网络名；waitMs 内查不完就先返回（控制台启动时最多等一会儿）。 */
function refreshMeta(waitMs = 0) {
  if (!meta.pending) {
    meta.pending = readMeta()
      .then((byIface) => {
        meta.byIface = byIface;
        meta.at = Date.now();
      })
      .finally(() => (meta.pending = null));
  }
  return Promise.race([meta.pending, new Promise((r) => setTimeout(r, waitMs))]);
}

// 返回按"最可能是朋友能连上的地址"排序的网络列表：[{ ip, iface, kind, name, category }]
// Windows 上刚换网络 / 开着 VPN 时，os.networkInterfaces() 偶尔会直接抛错
// （uv_interface_addresses returned Unknown system error），这时用上一次的结果，绝不能让服务器崩掉
let lastNets = [];
function interfaces() {
  try {
    return os.networkInterfaces();
  } catch {
    return null;
  }
}
function lanNetworks(ifs = interfaces()) {
  if (!ifs) return lastNets;
  if (Date.now() - meta.at > 30000) refreshMeta(); // 网络名过期了：后台再查一次，这次先用旧的
  const out = [];
  for (const [iface, list] of Object.entries(ifs)) {
    for (const a of list || []) {
      // Node 18.0~18.3 里 family 是数字 4
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) {
        // 198.18.x.x 是 Clash 等代理软件 TUN 模式的虚拟地址，朋友连不上
        const virtual = VIRTUAL.test(iface) || /^198\.1[89]\./.test(a.address);
        const m = meta.byIface[iface] || {};
        const kind = virtual ? 'other' : m.wifi ? 'wifi' : kindOf(iface, a.address);
        const score = (virtual ? -10 : 0) + KIND_SCORE[kind] + privateScore(a.address);
        out.push({ ip: a.address, iface, kind, name: m.name || '', category: m.category || '', virtual, score });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  // 电脑有很多网卡、显示的地址不对时，可以用 LAN_IP=192.168.1.5 手动指定
  const forced = (process.env.LAN_IP || '').trim();
  if (forced) {
    const hit = out.find((n) => n.ip === forced);
    out.splice(out.indexOf(hit), hit ? 1 : 0);
    out.unshift(hit || { ip: forced, iface: 'LAN_IP', kind: 'other', name: '', category: '', virtual: false, score: 99 });
  }
  lastNets = out.map(({ score, ...n }) => n);
  return lastNets;
}
/** 只要地址（旧接口，按同样的顺序）。 */
const lanAddresses = () => lanNetworks().map((n) => n.ip);

// 在控制台用方块字符画二维码（黑白用 ANSI 颜色，手机扫得出来）
let qrLib = null;
async function terminalQR(text) {
  if (!qrLib) qrLib = (await import(pathToFileURL(path.join(__dirname, '..', 'public', 'vendor', 'qrcode.mjs')).href)).default;
  const qr = qrLib(0, 'L');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = 2; // 留白
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -m; r < n + m; r += 2) {
    let line = '\x1b[30;47m';
    for (let c = -m; c < n + m; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push('  ' + line + '\x1b[0m');
  }
  return lines.join('\n');
}

// 打开默认浏览器（双击 start.bat / start.command 启动时用）
function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const p = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch {
    /* 打不开就算了，控制台里有地址 */
  }
}

module.exports = { lanAddresses, lanNetworks, refreshMeta, terminalQR, openBrowser };
