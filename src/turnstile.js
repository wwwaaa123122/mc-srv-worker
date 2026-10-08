/**
 * Cloudflare Turnstile 人机验证（服务端校验）。
 *
 * - 是否启用由 TURNSTILE_ENABLED + TURNSTILE_SITE_KEY（vars）决定
 * - TURNSTILE_SECRET 为服务端密钥（secret，写后不可读）
 * - 站点验证时同时校验 action 与 hostname，防止令牌被跨站重放
 */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_ACTION = "create";
const SITEVERIFY_TIMEOUT_MS = 10000;
const MAX_TOKEN_LENGTH = 2048;

function asBool(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function asString(value) {
  return String(value ?? "").trim();
}

/** 读取配置；siteKey 为空视为未启用 */
export function turnstileConfig(env) {
  const requested = asBool(env.TURNSTILE_ENABLED);
  const siteKey = asString(env.TURNSTILE_SITE_KEY);
  return {
    enabled: requested && siteKey.length > 0,
    siteKey
  };
}

/** 允许通过验证的 hostname 集合（TURNSTILE_HOSTNAMES 逗号分隔，回退 BASE_DOMAIN） */
function expectedHostnames(env) {
  const raw = asString(env.TURNSTILE_HOSTNAMES) || asString(env.BASE_DOMAIN);
  return new Set(
    raw
      .split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * 校验 Turnstile 令牌。
 * 返回 { ok: true } 或 { ok: false, error: 中文错误信息 }。
 */
export async function verifyTurnstile(env, token, clientIp) {
  if (!turnstileConfig(env).enabled) {
    return { ok: true, skipped: true };
  }

  const secret = asString(env.TURNSTILE_SECRET);
  if (!secret) {
    return { ok: false, error: "服务端未配置 Turnstile 密钥，请联系管理员" };
  }

  const expectHostnames = expectedHostnames(env);
  if (expectHostnames.size === 0) {
    return { ok: false, error: "服务端未配置 Turnstile 允许的域名" };
  }

  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, error: "请先完成人机验证" };
  }

  const body = new URLSearchParams({ secret, response: token });
  const ip = asString(clientIp);
  if (ip) body.set("remoteip", ip);

  let result;
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error("siteverify " + res.status);
    result = await res.json();
  } catch {
    return { ok: false, error: "人机验证服务暂时不可用，请稍后重试" };
  }

  if (!result || result.success !== true) {
    return { ok: false, error: "人机验证失败，请重新验证" };
  }
  if (result.action !== TURNSTILE_ACTION) {
    return { ok: false, error: "人机验证失败（action 不匹配）" };
  }
  if (!expectHostnames.has(asString(result.hostname).toLowerCase())) {
    return { ok: false, error: "人机验证失败（域名不匹配）" };
  }

  return { ok: true };
}
