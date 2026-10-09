/**
 * 论坛账号系统接入：星辰旅人论坛签发的 Access Token 验证。
 *
 * 论坛后端的 Access Token 为 RS256 签名的 JWT：
 *   header:  { alg: "RS256", typ: "JWT", kid }
 *   payload: { iss, sub(=论坛用户 id), aud, iat, exp, jti, typ: "access", role, sid }
 * 公钥通过 /.well-known/jwks.json 公布；本模块拉取 JWKS 并本地验签，
 * 不需要与论坛后端共享任何密钥。
 *
 * 论坛有两套签发方（共享同一套 D1 用户数据，但 JWT 签名密钥各自独立）：
 *   - forum-backend（i.182030.xyz）：本站"账号密码登录"走它签发的 Token；
 *   - xingchen-forum-x（x.182030.xyz，同时服务 forum.182030.xyz）：
 *     论坛网页端自身登录态签发的 Token（登录状态同步/桥接场景）。
 * 两者 iss 不同、公钥不同，因此按 Token 的 iss 选择对应的 JWKS 验签。
 *
 * 相关 vars（见 wrangler.toml）：
 *   FORUM_ISSUERS   — 逗号分隔的允许 iss 列表
 *   FORUM_JWKS_URLS — 与 FORUM_ISSUERS 一一对应的 JWKS 地址列表
 *   FORUM_ISSUER / FORUM_JWKS_URL — 旧的单值配置（兼容回退）
 *   FORUM_AUDIENCE  — 预期 aud
 *   FORUM_SSO_ORIGIN — 论坛站点自身的前端源（登录状态同步弹窗用）
 */

const JWKS_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_S = 30;

/** JWKS 缓存：url → { keys, fetchedAt } */
const jwksCache = new Map();
const publicKeyCache = new Map();

export function forumDefaults(env) {
  return {
    audience: env.FORUM_AUDIENCE || "api",
    ssoOrigin: (env.FORUM_SSO_ORIGIN || "https://forum.182030.xyz").replace(/\/+$/, "")
  };
}

function parseList(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** iss → JWKS URL 映射（FORUM_ISSUERS / FORUM_JWKS_URLS 一一对应；兼容旧单值变量） */
export function forumIssuerJwksMap(env) {
  const issuers = parseList(env.FORUM_ISSUERS);
  const urls = parseList(env.FORUM_JWKS_URLS);
  if (issuers.length > 0 && issuers.length === urls.length) {
    return new Map(issuers.map((iss, i) => [iss.replace(/\/+$/, ""), urls[i]]));
  }
  if (env.FORUM_JWKS_URL) {
    const iss = (env.FORUM_ISSUER || "https://i.182030.xyz").replace(/\/+$/, "");
    return new Map([[iss, env.FORUM_JWKS_URL]]);
  }
  return new Map();
}

function b64uToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function fetchJwks(env, jwksUrl, force = false) {
  const now = Date.now();
  const cached = jwksCache.get(jwksUrl);
  if (!force && cached && cached.keys && now - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }
  const res = await fetch(jwksUrl, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Error(`JWKS 拉取失败 (${res.status})`);
  const data = await res.json();
  const keys = Array.isArray(data.keys) ? data.keys : [];
  if (keys.length === 0) throw new Error("JWKS 中没有可用公钥");
  jwksCache.set(jwksUrl, { keys, fetchedAt: now });
  return keys;
}

async function importPublicKey(kid, jwk) {
  const cached = publicKeyCache.get(kid);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  publicKeyCache.set(kid, key);
  return key;
}

/**
 * 验证论坛 Access Token（按 Token 的 iss 选择对应签发方的 JWKS）。
 * 成功返回 { ok: true, uid, payload }；失败返回 { ok: false, reason }。
 * 遇到未知 kid 时强制刷新一次 JWKS（密钥轮换场景）。
 */
export async function verifyForumToken(env, token) {
  const { audience } = forumDefaults(env);

  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64uToBytes(parts[1])));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (header.alg !== "RS256") return { ok: false, reason: "alg" };
  if (typeof header.kid !== "string") return { ok: false, reason: "malformed" };
  if (payload.typ !== "access") return { ok: false, reason: "typ" };

  const jwksMap = forumIssuerJwksMap(env);
  const iss = String(payload.iss || "").replace(/\/+$/, "");
  const jwksUrl = jwksMap.get(iss);
  if (!jwksUrl) return { ok: false, reason: "iss" };

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) return { ok: false, reason: "aud" };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < now) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.iat !== "number" || payload.iat - CLOCK_SKEW_S > now) {
    return { ok: false, reason: "iat" };
  }

  let keys = await fetchJwks(env, jwksUrl);
  let entry = keys.find((k) => k.kid === header.kid);
  if (!entry) {
    keys = await fetchJwks(env, jwksUrl, true);
    entry = keys.find((k) => k.kid === header.kid);
  }
  if (!entry) return { ok: false, reason: "unknown_kid" };

  const publicKey = await importPublicKey(header.kid, entry);
  let signature;
  try {
    signature = b64uToBytes(parts[2]);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) return { ok: false, reason: "signature" };

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, uid: payload.sub, payload };
}

function getBearerToken(request) {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/**
 * 从请求中解析论坛登录态。
 * 返回 { present, ok, uid?, reason? }：
 *   present=false            — 未携带 Token（匿名请求）
 *   present=true, ok=true    — 已通过论坛账号验证（uid = 论坛用户 id）
 *   present=true, ok=false   — 携带了 Token 但无效/过期（应返回 401 触发前端刷新）
 */
export async function forumUserFromRequest(env, request) {
  const token = getBearerToken(request);
  if (!token) return { present: false, ok: false };
  const result = await verifyForumToken(env, token);
  if (!result.ok) return { present: true, ok: false, reason: result.reason };
  return { present: true, ok: true, uid: result.uid };
}

/**
 * 获取论坛公开配置（Turnstile site key 等），模块级缓存 5 分钟。
 * 拉取失败时返回 siteKey = null，前端登录表单则不渲染验证组件。
 */
let forumConfigCache = { data: null, fetchedAt: 0 };
const FORUM_CONFIG_TTL_MS = 5 * 60 * 1000;

export async function forumPublicConfig(env) {
  const now = Date.now();
  if (forumConfigCache.data && now - forumConfigCache.fetchedAt < FORUM_CONFIG_TTL_MS) {
    return forumConfigCache.data;
  }
  const base = (env.FORUM_API_BASE || "https://i.182030.xyz").replace(/\/+$/, "");
  const fallback = {
    apiBase: base,
    turnstileSiteKey: null,
    registerUrl: "https://forum.182030.xyz/register",
    ssoOrigin: forumDefaults(env).ssoOrigin
  };
  try {
    const res = await fetch(`${base}/api/config`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const out = {
      apiBase: base,
      turnstileSiteKey: (data && data.turnstileSiteKey) || null,
      registerUrl: "https://forum.182030.xyz/register",
      ssoOrigin: forumDefaults(env).ssoOrigin
    };
    forumConfigCache = { data: out, fetchedAt: now };
    return out;
  } catch {
    return fallback;
  }
}
