/**
 * MC 免端口域名生成器 —— Worker 入口。
 *
 * 匿名流程：地址 + 可选前缀 → 创建 SRV → 返回域名与授权码（原有行为）。
 * 论坛账号流程（接入 星辰旅人论坛 账号系统）：
 *   - 请求头 Authorization: Bearer <论坛 Access Token>（RS256 JWT，本地验签）
 *   - 创建时记录绑定到论坛用户，免人机验证、可用「我的域名」管理
 *   - GET  /api/my/records 列出当前账号绑定的记录
 *   - POST /api/claim      用 前缀 + 授权码 把历史记录认领到当前账号
 *   - POST /api/sso/redeem 用论坛桥接页的一次性 ticket 兑换登录凭证（服务器对服务器）
 *   - 修改/删除：授权码 或 账号绑定关系，满足其一即可
 */
import { createDNSRecords } from "./dns";
import { updateDNS } from "./update";
import { deleteDNS } from "./delete";
import { verifyAuthCode } from "./auth";
import { rateLimitCheck } from "./rateLimit";
import { validateInput, validatePrefix } from "./validator";
import { turnstileConfig, verifyTurnstile } from "./turnstile";
import { isBlockedTarget, blockedTargetReason } from "./ipGuard";
import { forumUserFromRequest, forumPublicConfig } from "./forum-auth";
import { bindUser, countUserRecords, listUserRecords } from "./user-records";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

/** 安全读取 JSON body；非法 JSON 返回 null（调用方回 400，而不是 500） */
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** 变更类接口仅接受 application/json：阻止跨站表单/简单请求触发写操作（CSRF 加固） */
function isJsonRequest(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  return ct.split(";")[0].trim() === "application/json";
}

function notJsonResponse() {
  return json({ error: "请求需使用 Content-Type: application/json" }, 415);
}

/** 未通过账号验证时的 401（前端据此触发刷新/重新登录） */
function authError(auth) {
  if (!auth.present) {
    return json({ error: "请先登录论坛账号", code: "AUTH_REQUIRED" }, 401);
  }
  return json({ error: "登录状态无效或已过期，请重新登录", code: "AUTH_INVALID" }, 401);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // 站点配置：人机验证 + 论坛账号系统信息（前端启动时读取）
      if (url.pathname === "/api/config" && request.method === "GET") {
        const { enabled, siteKey } = turnstileConfig(env);
        const forum = await forumPublicConfig(env);
        return json({
          turnstile: {
            enabled,
            siteKey: enabled ? siteKey : "",
            action: "create"
          },
          forum
        });
      }

      // 登录状态同步：用论坛桥接页签发的一次性 ticket 兑换凭证
      // （浏览器只经手一次性短命 ticket；真正的 token 由本 Worker 与论坛 API 之间流转）
      if (url.pathname === "/api/sso/redeem" && request.method === "POST") {
        if (!isJsonRequest(request)) return notJsonResponse();
        const ip = request.headers.get("cf-connecting-ip") || "";
        if (!(await rateLimitCheck(env, `sso:${ip}`))) {
          return json({ error: "操作过于频繁，请稍后再试" }, 429);
        }

        const body = await readJson(request);
        if (!body) return json({ error: "请求体不是合法 JSON" }, 400);
        const ticket = typeof body.ticket === "string" ? body.ticket.trim() : "";
        const challenge = typeof body.challenge === "string" ? body.challenge.trim() : "";
        if (!ticket || !challenge) {
          return json({ error: "缺少登录同步凭证", code: "SSO_PARAMS_MISSING" }, 400);
        }

        const apiBase = (env.FORUM_API_BASE || "https://i.182030.xyz").replace(/\/+$/, "");
        const origin = new URL(request.url).origin;
        let upstream;
        try {
          upstream = await fetch(`${apiBase}/api/auth/site-login/redeem`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticket, challenge, origin })
          });
        } catch {
          return json({ error: "论坛服务暂时不可达，请稍后重试", code: "SSO_UPSTREAM_ERROR" }, 502);
        }

        let data = null;
        try {
          data = await upstream.json();
        } catch {
          data = null;
        }
        if (!upstream.ok || !data || !data.accessToken) {
          const message = (data && data.error && data.error.message) || "登录同步凭证无效或已过期";
          return json({ error: message, code: (data && data.error && data.error.code) || "SSO_FAILED" }, 400);
        }

        return json({
          success: true,
          user: data.user || null,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken || null,
          accessExpiresIn: data.accessExpiresIn || null
        });
      }

      // 当前账号绑定的域名列表
      if (url.pathname === "/api/my/records" && request.method === "GET") {
        const auth = await forumUserFromRequest(env, request);
        if (!auth.ok) return authError(auth);
        const records = await listUserRecords(env, auth.uid);
        return json({ success: true, records });
      }

      // 认领历史记录：前缀 + 授权码 → 绑定到当前论坛账号
      if (url.pathname === "/api/claim" && request.method === "POST") {
        if (!isJsonRequest(request)) return notJsonResponse();
        const ip = request.headers.get("cf-connecting-ip") || "";
        if (!(await rateLimitCheck(env, `claim:${ip}`))) {
          return json({ error: "操作过于频繁，请稍后再试" }, 429);
        }

        const auth = await forumUserFromRequest(env, request);
        if (!auth.ok) return authError(auth);

        const body = await readJson(request);
        if (!body) return json({ error: "请求体不是合法 JSON" }, 400);

        const sub = String(body.sub || "").trim().toLowerCase();
        const authCode = String(body.authCode || "").trim();
        if (!sub || !authCode) {
          return json({ error: "前缀和授权码均为必填项" }, 400);
        }
        if (!/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(sub)) {
          return json({ error: "前缀格式不正确" }, 400);
        }

        const dataRaw = await env.MC_KV.get(sub);
        if (!dataRaw) return json({ error: "记录不存在" }, 404);

        let data;
        try {
          data = JSON.parse(dataRaw);
        } catch {
          return json({ error: "记录数据异常" }, 500);
        }

        if (!verifyAuthCode(data.authCode, authCode)) {
          return json({ error: "授权码错误" }, 403);
        }
        if (data.user_id && data.user_id !== auth.uid) {
          return json({ error: "该记录已绑定其他账号", code: "ALREADY_BOUND" }, 409);
        }

        // 认领同样计入账号配额，防止绕过 USER_RECORD_LIMIT
        const claimQuota = parseInt(env.USER_RECORD_LIMIT || "10");
        const claimCount = await countUserRecords(env, auth.uid);
        if (claimCount >= claimQuota) {
          return json(
            { error: `当前账号绑定的域名已达上限（${claimQuota} 个）`, code: "QUOTA_EXCEEDED" },
            409
          );
        }

        const bound = await bindUser(env, auth.uid, sub, data);
        return json({
          success: true,
          record: {
            sub,
            domain: `${sub}.${env.BASE_DOMAIN}`,
            target: bound.target,
            port: bound.port,
            created: bound.created || null
          }
        });
      }

      // 创建域名
      if (url.pathname === "/api/create" && request.method === "POST") {
        if (!isJsonRequest(request)) return notJsonResponse();
        const ip = request.headers.get("cf-connecting-ip") || "";
        const allowed = await rateLimitCheck(env, ip);

        if (!allowed) {
          return json({ error: "rate limited" }, 429);
        }

        const body = await readJson(request);
        if (!body) return json({ error: "请求体不是合法 JSON" }, 400);

        const { address, prefix, authCode: adminCode } = body;

        // 论坛账号登录态：已登录用户免人机验证（身份由论坛账号系统保证）
        const auth = await forumUserFromRequest(env, request);
        if (auth.present && !auth.ok) return authError(auth);

        if (!auth.ok) {
          const human = await verifyTurnstile(
            env,
            body["cf-turnstile-response"] ?? body.turnstileToken,
            ip
          );
          if (!human.ok) {
            return json({ error: human.error }, 403);
          }
        }

        if (env.REQUIRE_AUTH === "true") {
          if (!verifyAuthCode(env.ADMIN_CODE, adminCode)) {
            return json({ error: "invalid auth" }, 403);
          }
        }

        const parsed = validateInput(address);
        if (!parsed) {
          return json({ error: "invalid input" }, 400);
        }

        const { host, port } = parsed;

        if (isBlockedTarget(host)) {
          return json({ error: blockedTargetReason(host) }, 403);
        }

        const prefixCheck = validatePrefix(prefix);
        if (!prefixCheck.ok) {
          return json({ error: prefixCheck.reason }, 400);
        }

        const sub =
          prefixCheck.value ||
          ("mc-" + crypto.randomUUID().slice(0, 6));

        // 前缀占用检查（KV 中已有记录即视为占用，避免重复解析）
        const existing = await env.MC_KV.get(sub);
        if (existing) {
          return json({ error: "该前缀已被占用，请换一个", code: "SUB_TAKEN" }, 409);
        }

        // 账号配额
        if (auth.ok) {
          const quota = parseInt(env.USER_RECORD_LIMIT || "10");
          const count = await countUserRecords(env, auth.uid);
          if (Number.isFinite(quota) && count >= quota) {
            return json(
              { error: `当前账号绑定的域名已达上限（${quota} 个）`, code: "QUOTA_EXCEEDED" },
              409
            );
          }
        }

        const result = await createDNSRecords(
          env,
          sub,
          host,
          port,
          auth.ok ? auth.uid : null
        );

        if (auth.ok) {
          await bindUser(env, auth.uid, sub, result.record);
        }

        return json({
          success: true,
          domain: result.domain,
          authCode: result.authCode,
          bound: Boolean(auth.ok)
        });
      }

      // 修改解析
      if (url.pathname === "/api/update" && request.method === "POST") {
        if (!isJsonRequest(request)) return notJsonResponse();
        const ip = request.headers.get("cf-connecting-ip") || "";
        if (!(await rateLimitCheck(env, `upd:${ip}`))) {
          return json({ error: "操作过于频繁，请稍后再试" }, 429);
        }

        const body = await readJson(request);
        if (!body) return json({ error: "请求体不是合法 JSON" }, 400);

        const { sub, target, port, authCode } = body;

        const auth = await forumUserFromRequest(env, request);
        if (auth.present && !auth.ok) return authError(auth);

        if (!sub || !target || !port) {
          return json({ error: "参数不完整" }, 400);
        }
        if (typeof sub !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(sub.trim().toLowerCase())) {
          return json({ error: "前缀格式不正确" }, 400);
        }
        if (typeof target !== "string" || !/^[a-z0-9_.:-]{1,253}$/i.test(target.trim())) {
          return json({ error: "服务器地址格式不正确" }, 400);
        }
        const portNum = parseInt(port, 10);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
          return json({ error: "端口需为 1~65535 的整数" }, 400);
        }
        if (!authCode && !auth.ok) {
          return json({ error: "请填写授权码，或先登录论坛账号" }, 400);
        }

        if (isBlockedTarget(target)) {
          return json({ error: blockedTargetReason(target) }, 403);
        }

        const result = await updateDNS(env, sub, target, port, {
          authCode,
          uid: auth.ok ? auth.uid : null
        });

        return json(result);
      }

      // 删除解析
      if (url.pathname === "/api/delete" && request.method === "POST") {
        if (!isJsonRequest(request)) return notJsonResponse();
        const ip = request.headers.get("cf-connecting-ip") || "";
        if (!(await rateLimitCheck(env, `del:${ip}`))) {
          return json({ error: "操作过于频繁，请稍后再试" }, 429);
        }

        const body = await readJson(request);
        if (!body) return json({ error: "请求体不是合法 JSON" }, 400);

        const { sub, authCode } = body;

        const auth = await forumUserFromRequest(env, request);
        if (auth.present && !auth.ok) return authError(auth);

        if (!sub) {
          return json({ error: "参数不完整" }, 400);
        }
        if (!authCode && !auth.ok) {
          return json({ error: "请填写授权码，或先登录论坛账号" }, 400);
        }

        const result = await deleteDNS(env, sub, {
          authCode,
          uid: auth.ok ? auth.uid : null
        });

        return json(result);
      }

      // Static assets - serve all non-API requests
      if (!url.pathname.startsWith("/api/")) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not Found", { status: 404 });

    } catch (e) {
      return json(
        {
          error: e.message,
          stack: e.stack
        },
        500
      );
    }
  }
};
