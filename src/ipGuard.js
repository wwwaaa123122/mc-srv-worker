/**
 * 目标地址黑名单：禁止指向内网地址与公共 DNS 等公共服务地址，
 * 防止 SRV 记录被滥用于探测/转发。
 */
const BLOCKED_EXACT_IPS = [
  "1.1.1.1",
  "8.8.8.8",
  "1.2.3.4"
];

const BLOCKED_IP_PREFIXES = [
  "192.168."
];

export function isBlockedTarget(host) {
  const value = String(host ?? "").trim().toLowerCase();
  if (!value) return false;
  if (BLOCKED_EXACT_IPS.includes(value)) return true;
  return BLOCKED_IP_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function blockedTargetReason(host) {
  return `地址 ${String(host).trim()} 属于内网或公共服务地址，禁止创建解析`;
}
