import { writeIndex } from "./user-records";

/**
 * 修改已有解析（A + SRV）。
 *
 * 鉴权两种方式（满足其一即可）：
 *   - authCode 与记录的授权码匹配（匿名/历史使用方式）
 *   - opts.uid 与记录绑定的论坛用户 id 一致（已登录用户免授权码）
 */
export async function updateDNS(env, sub, newTarget, newPort, opts = {}) {
  const authCode = opts.authCode;
  const uid = opts.uid;

  const base = env.BASE_DOMAIN;

  const headers = {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  const dryRun = !env.CF_API_TOKEN || env.DRY_RUN === "true";

  const key = sub;
  const dataRaw = await env.MC_KV.get(key);

  if (!dataRaw) throw new Error("记录不存在");

  const data = JSON.parse(dataRaw);

  const isOwner = Boolean(uid && data.user_id && data.user_id === uid);
  if (!isOwner) {
    if (!authCode) throw new Error("缺少授权码");
    if (data.authCode !== authCode) throw new Error("授权码错误");
  }

  const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(newTarget);

  let finalTarget = newTarget;
  let aRecordName = data.aRecord;

  if (isIP) {
    if (!aRecordName) {
      aRecordName = "mc-" + crypto.randomUUID().slice(0, 6) + "." + base;

      if (dryRun) {
        console.warn(`[DRY_RUN] 跳过 A 记录创建: ${aRecordName} -> ${newTarget}`);
      } else {
        const aCreate = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              type: "A",
              name: aRecordName,
              content: newTarget,
              ttl: 120,
            }),
          }
        );

        const aJson = await aCreate.json();
        if (!aJson.success) {
          throw new Error("A记录创建失败: " + JSON.stringify(aJson.errors));
        }
      }
    } else {
      if (dryRun) {
        console.warn(`[DRY_RUN] 跳过 A 记录更新: ${aRecordName} -> ${newTarget}`);
      } else {
        const listRes = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records?type=A&name=${aRecordName}`,
          { headers }
        );

        const listJson = await listRes.json();
        if (!listJson.success) throw new Error("查询A记录失败");

        if (listJson.result.length > 0) {
          const recordId = listJson.result[0].id;

          const updateRes = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
            {
              method: "PUT",
              headers,
              body: JSON.stringify({
                type: "A",
                name: aRecordName,
                content: newTarget,
                ttl: 120,
              }),
            }
          );

          const updateJson = await updateRes.json();
          if (!updateJson.success) {
            throw new Error("A记录更新失败: " + JSON.stringify(updateJson.errors));
          }
        }
      }
    }

    finalTarget = aRecordName;
  } else if (aRecordName) {
    // 目标从 IP 换成了域名：旧的 A 记录不再被引用，清掉避免残留
    if (dryRun) {
      console.warn(`[DRY_RUN] 跳过清理旧 A 记录: ${aRecordName}`);
    } else {
      const listRes = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records?type=A&name=${aRecordName}`,
        { headers }
      );
      const listJson = await listRes.json();
      if (listJson.success && listJson.result.length > 0) {
        await fetch(
          `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${listJson.result[0].id}`,
          { method: "DELETE", headers }
        );
      }
    }
    aRecordName = null;
  }

  const srvName = `_minecraft._tcp.${sub}.${base}`;

  if (dryRun) {
    console.warn(`[DRY_RUN] 跳过 SRV 记录更新: ${srvName} -> ${finalTarget}:${newPort}`);
  } else {
    const srvList = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records?type=SRV&name=${srvName}`,
      { headers }
    );

    const srvJson = await srvList.json();
    if (!srvJson.success) throw new Error("查询SRV失败");

    if (srvJson.result.length > 0) {
      const srvId = srvJson.result[0].id;

      const srvUpdate = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${srvId}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            type: "SRV",
            name: srvName,
            data: {
              priority: 0,
              weight: 5,
              port: parseInt(newPort),
              target: finalTarget
            }
          }),
        }
      );

      const srvResult = await srvUpdate.json();
      if (!srvResult.success) {
        throw new Error("SRV更新失败: " + JSON.stringify(srvResult.errors));
      }
    } else {
      throw new Error("SRV记录不存在");
    }
  }

  const updated = {
    ...data,
    target: finalTarget,
    port: newPort,
    aRecord: isIP ? finalTarget : null
  };

  await env.MC_KV.put(
    key,
    JSON.stringify(updated)
  );

  // 绑定了论坛用户的记录：同步刷新索引快照
  if (data.user_id) {
    try {
      await writeIndex(env, data.user_id, sub, updated);
    } catch (e) {
      console.error("索引刷新失败:", e.message);
    }
  }

  return { success: true };
}
