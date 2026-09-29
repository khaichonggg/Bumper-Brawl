// 局域网地址：电脑同时连着网线和 Wi-Fi（两个不同的网络）时，Wi-Fi 的地址排第一，虚拟网卡排最后
const { check, done } = require('./helpers');
const { lanNetworks } = require('../server/lan');

const v4 = (address) => ({ family: 'IPv4', address, internal: false });
const ifs = {
  以太网: [v4('192.168.0.138')],
  'vEthernet (WSL)': [v4('172.26.160.1')],
  Tailscale: [v4('100.95.67.103')],
  WLAN: [v4('192.168.68.142')],
  '本地连接* 10': [v4('192.168.137.1')],
  蓝牙网络连接: [v4('169.254.173.57')],
  Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
};
const nets = lanNetworks(ifs);
const ips = nets.map((n) => n.ip);
check(ips[0] === '192.168.68.142', `Wi-Fi 地址排第一（${ips.join(', ')}）`);
check(ips[1] === '192.168.137.1' && nets[1].kind === 'hotspot', '其次是这台电脑开的移动热点');
check(ips[2] === '192.168.0.138' && nets[2].kind === 'wired', '然后是网线');
check(!ips.includes('169.254.173.57') && !ips.includes('127.0.0.1'), '不列出 169.254 自动地址和本机回环');
check(nets.filter((n) => n.virtual).map((n) => n.ip).sort().join() === '100.95.67.103,172.26.160.1', 'WSL / Tailscale 标成虚拟网卡');
check(nets.slice(-2).every((n) => n.virtual), '虚拟网卡排在最后');

process.env.LAN_IP = '192.168.0.138';
check(lanNetworks(ifs)[0].ip === '192.168.0.138', 'LAN_IP 可以手动指定排第一的地址');
delete process.env.LAN_IP;
check(lanNetworks(null).length === nets.length, 'os.networkInterfaces() 出错时用上一次的结果，不会崩');
done();
