export function validateInput(input) {
  if (!input) return null;

  const parts = input.split(":");

  if (parts.length !== 2) return null;

  const host = parts[0].trim();
  const port = parseInt(parts[1]);

  if (!host || isNaN(port)) return null;

  if (port < 1 || port > 65535) return null;

  return { host, port };
}

/**
 * 校验自定义前缀：小写字母/数字/连字符，1~20 位，字母或数字开头结尾。
 * 返回 { ok: true, value }（value 为规范化后的小写前缀，空输入时为 null）
 * 或 { ok: false, reason }。
 */
export function validatePrefix(prefix) {
  const value = String(prefix || "").trim().toLowerCase();
  if (!value) return { ok: true, value: null };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(value)) {
    return {
      ok: false,
      reason: "前缀仅支持 1~20 位小写字母、数字或连字符，且需以字母或数字开头结尾"
    };
  }
  return { ok: true, value };
}
