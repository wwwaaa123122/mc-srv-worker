/**
 * 目标地址黑名单：禁止把解析指向内网/保留/链路本地/元数据地址与公共服务地址。
 *
 * 覆盖常见绕过写法：十进制整数 IP（16843009 = 1.1.1.1）、十六进制（0x01010101）、
 * 八进制（0300.0250.0.1）、短写（127.1）、尾点（1.2.3.4.）、IPv6 映射 IPv4
 * （::ffff:192.168.1.1）、IPv6 内网/链路本地/ULA、localhost 变体。
 */
const BLOCKED_EXACT_IPS = new Set([
  "1.1.1.1",
  "8.8.8.8",
  "1.2.3.4",
  "0.0.0.0",
  "255.255.255.255",
]);

const HOSTNAME_BLOCKLIST = new Set([
  "localhost",
  "metadata.google.internal",
]);

const HOSTNAME_BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
];

function parseIpPart(raw) {
  if (!/^\d{1,10}$/.test(raw)) return null;
  if (raw.length > 1 && raw.startsWith("0")) {
    const v = parseInt(raw, 8); // 前导零按八进制（08/09 非法八进制 → 拒绝）
    return Number.isNaN(v) || v > 255 ? null : v;
  }
  const v = parseInt(raw, 10);
  return v > 255 ? null : v;
}

function ipToInt(parts) {
  if (parts.length !== 4) return null;
  let n = 0;
  for (const raw of parts) {
    const v = parseIpPart(raw);
    if (v === null) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** inet_aton 语义：a.b.c.d / a.b.c / a.b / a 均可表示 IPv4 */
function fromInetAton(s) {
  if (!/^[0-9.]+$/.test(s)) return null;
  const parts = s.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  if (parts.some((p) => p === "")) return null;

  if (parts.length === 4) {
    const n = ipToInt(parts);
    return n === null ? null : intToIp(n);
  }

  let value = 0;
  for (const raw of parts.slice(0, -1)) {
    const v = parseIpPart(raw);
    if (v === null) return null;
    value = value * 256 + v;
  }
  const last = parts[parts.length - 1];
  if (!/^\d{1,10}$/.test(last)) return null;
  const lastV = last.length > 1 && last.startsWith("0") ? parseInt(last, 8) : parseInt(last, 10);
  if (Number.isNaN(lastV) || lastV < 0) return null;
  const maxLast = Math.pow(256, 4 - parts.length + 1) - 1;
  if (lastV > maxLast) return null;
  value = value * (maxLast + 1) + lastV;
  return intToIp(value >>> 0);
}

/** 规范化输入：还原各种 IPv4 等价写法，返回规范点分十进制或原样主机名（小写、去尾点） */
export function normalizeHost(raw) {
  let s = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!s) return "";
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n >= 0 && n <= 4294967295) return intToIp(n >>> 0);
    return s;
  }
  if (/^0x[0-9a-f]+$/.test(s)) {
    const n = parseInt(s, 16);
    if (n >= 0 && n <= 4294967295) return intToIp(n >>> 0);
    return s;
  }
  if (/^[0-9.]+$/.test(s)) {
    const ip = fromInetAton(s);
    if (ip) return ip;
    return s;
  }
  const mapped = /^\[?(?:::(?:ffff:)?)([0-9.]{7,15})\]?$/.exec(s);
  if (mapped) {
    const ip = fromInetAton(mapped[1]);
    if (ip) return ip;
  }
  return s;
}

function isPrivateOrReservedIp(ip) {
  if (BLOCKED_EXACT_IPS.has(ip)) return true;
  const parts = ip.split(".").map((x) => parseInt(x, 10));
  if (parts.length !== 4 || parts.some((x) => Number.isNaN(x))) return false;
  const [a, b] = parts;
  if (a === 0) return true;                      // 0.0.0.0/8
  if (a === 10) return true;                     // 10.0.0.0/8
  if (a === 127) return true;                    // 127.0.0.0/8
  if (a === 169 && b === 254) return true;       // 169.254.0.0/16（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true;             // 192.0.0.0/24 与 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;
  if (a >= 224) return true;                     // 组播 + 保留 + 广播
  return false;
}

function isReservedIpv6(s) {
  const v = s.replace(/^\[|\]$/g, "");
  if (!v.includes(":")) return false;
  if (/^::1$/.test(v) || v === "::") return true;                 // 未指定/环回
  if (/^f[de]/.test(v)) return true;                              // fc00::/7 ULA、fe80::/10 链路本地
  if (/^ff/.test(v)) return true;                                 // 组播
  if (/^2001:db8:/i.test(v)) return true;                         // 文档段
  const mapped = /^::ffff:([0-9a-f.]+)$/i.exec(v);
  if (mapped) {
    const ip = fromInetAton(mapped[1]) || (fromInetAton(normalizeHost(mapped[1]) ?? "") ?? "");
    if (ip && isPrivateOrReservedIp(ip)) return true;
  }
  return false;
}

export function isBlockedTarget(host) {
  const value = normalizeHost(host);
  if (!value) return false;
  if (HOSTNAME_BLOCKLIST.has(value)) return true;
  if (HOSTNAME_BLOCKED_SUFFIXES.some((suffix) => value.endsWith(suffix))) return true;
  if (isReservedIpv6(value)) return true;
  if (/^[0-9.]+$/.test(value) && value.includes(".")) {
    if (isPrivateOrReservedIp(value)) return true;
  }
  return false;
}

export function blockedTargetReason(host) {
  return `地址 ${String(host ?? "").trim()} 属于内网、保留或公共服务地址，禁止用于解析`;
}
