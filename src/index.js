import { createDNSRecords } from "./dns";
import { updateDNS } from "./update";
import { deleteDNS } from "./delete";
import { generateAuthCode, verifyAuthCode } from "./auth";
import { rateLimitCheck } from "./rateLimit";
import { validateInput } from "./validator";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // API routes
      if (url.pathname === "/api/create" && request.method === "POST") {
        const ip = request.headers.get("cf-connecting-ip") || "";
        const allowed = await rateLimitCheck(env, ip);

        if (!allowed) {
          return json({ error: "rate limited" }, 429);
        }

        const body = await request.json();
        const { address, prefix, authCode: adminCode } = body;

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

        const sub =
          (prefix && prefix.trim()) ||
          ("mc-" + crypto.randomUUID().slice(0, 6));

        const result = await createDNSRecords(env, sub, host, port);

        return json({
          success: true,
          domain: result.domain,
          authCode: result.authCode
        });
      }

      if (url.pathname === "/api/update" && request.method === "POST") {
        const { sub, target, port, authCode } = await request.json();

        if (!sub || !target || !port || !authCode) {
          return json({ error: "参数不完整" }, 400);
        }

        const result = await updateDNS(env, sub, target, port, authCode);

        return json(result);
      }

      if (url.pathname === "/api/delete" && request.method === "POST") {
        const { sub, authCode } = await request.json();

        if (!sub || !authCode) {
          return json({ error: "参数不完整" }, 400);
        }

        const result = await deleteDNS(env, sub, authCode);

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
