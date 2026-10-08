/**
 * 删除解析（A + SRV + KV）。
 *
 * 鉴权两种方式（满足其一即可）：
 *   - authCode 与记录的授权码匹配（匿名/历史使用方式）
 *   - opts.uid 与记录绑定的论坛用户 id 一致（已登录用户免授权码）
 */
import { removeIndex } from "./user-records";

export async function deleteDNS(env, sub, opts = {}) {
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

  const srvName = `_minecraft._tcp.${sub}.${base}`;

  if (dryRun) {
    console.warn(`[DRY_RUN] 跳过 SRV 记录删除: ${srvName}`);
  } else {
    const srvList = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records?type=SRV&name=${srvName}`,
      { headers }
    );

    const srvJson = await srvList.json();
    if (!srvJson.success) throw new Error("查询SRV失败");

    if (srvJson.result.length > 0) {
      const srvId = srvJson.result[0].id;

      const del = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${srvId}`,
        {
          method: "DELETE",
          headers
        }
      );

      const delJson = await del.json();
      if (!delJson.success) {
        throw new Error("删除SRV失败: " + JSON.stringify(delJson.errors));
      }
    }

    if (data.aRecord) {
      const aList = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records?type=A&name=${data.aRecord}`,
        { headers }
      );

      const aJson = await aList.json();
      if (!aJson.success) throw new Error("查询A记录失败");

      if (aJson.result.length > 0) {
        const aId = aJson.result[0].id;

        const del = await fetch(
          `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${aId}`,
          {
            method: "DELETE",
            headers
          }
        );

        const delJson = await del.json();
        if (!delJson.success) {
          throw new Error("删除A记录失败: " + JSON.stringify(delJson.errors));
        }
      }
    }
  }

  await env.MC_KV.delete(key);

  // 绑定了论坛用户的记录：同步清理索引
  if (data.user_id) {
    try {
      await removeIndex(env, data.user_id, sub);
    } catch (e) {
      console.error("索引清理失败:", e.message);
    }
  }

  return { success: true };
}
