export async function deleteDNS(env, sub, authCode) {
  const base = env.BASE_DOMAIN;

  const headers = {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  const key = sub;
  const dataRaw = await env.MC_KV.get(key);

  if (!dataRaw) throw new Error("记录不存在");

  const data = JSON.parse(dataRaw);

  if (data.authCode !== authCode) throw new Error("授权码错误");

  const srvName = `_minecraft._tcp.${sub}.${base}`;

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

  await env.MC_KV.delete(key);

  return { success: true };
}
