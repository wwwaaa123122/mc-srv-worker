/**
 * 创建 DNS 记录（A + SRV）。
 *
 * @param userId 论坛用户 id（已登录创建时传入，用于账号绑定；匿名创建传 null）
 *
 * DRY_RUN=未配置 CF_API_TOKEN 时跳过真实 DNS 写入（仅本地开发/冒烟测试用），
 * 只落 KV，便于在本地完整走通业务流程。
 */
export async function createDNSRecords(env, sub, targetHost, port, userId = null) {
  const base = env.BASE_DOMAIN;

  const headers = {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  // 本地开发/冒烟测试：无 API Token 或显式 DRY_RUN=true 时不碰真实 DNS
  const dryRun = !env.CF_API_TOKEN || env.DRY_RUN === "true";

  const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(targetHost);

  const randomSub = "mc-" + crypto.randomUUID().slice(0, 6);
  const fullAName = `${randomSub}.${base}`;

  const authCode = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  let finalTarget = targetHost;

  if (isIP) {
    if (dryRun) {
      console.warn(`[DRY_RUN] 跳过 A 记录创建: ${fullAName} -> ${targetHost}`);
    } else {
      const aRes = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            type: "A",
            name: fullAName,
            content: targetHost,
            ttl: 120,
          }),
        }
      );

      const aJson = await aRes.json();

      if (!aJson.success) {
        throw new Error("A记录创建失败: " + JSON.stringify(aJson.errors));
      }
    }

    finalTarget = fullAName;
  }

  const record = {
    target: finalTarget,
    port,
    authCode,
    created: Date.now(),
    aRecord: isIP ? fullAName : null,
    user_id: userId || null
  };

  await env.MC_KV.put(
    sub,
    JSON.stringify(record)
  );

  if (dryRun) {
    console.warn(`[DRY_RUN] 跳过 SRV 记录创建: _minecraft._tcp.${sub}.${base}`);
    return {
      domain: `${sub}.${base}`,
      authCode,
      record,
      dryRun
    };
  }

  const srvRes = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "SRV",
        name: `_minecraft._tcp.${sub}.${base}`,
        data: {
          priority: 0,
          weight: 5,
          port: parseInt(port),
          target: finalTarget
        }
      }),
    }
  );

  const srvJson = await srvRes.json();

  if (!srvJson.success) {
    throw new Error("SRV创建失败: " + JSON.stringify(srvJson.errors));
  }

  return {
    domain: `${sub}.${base}`,
    authCode,
    record,
    dryRun
  };
}
