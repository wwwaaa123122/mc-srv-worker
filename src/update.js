export async function updateDNS(env, sub, newTarget, newPort, authCode) {
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

  const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(newTarget);

  let finalTarget = newTarget;
  let aRecordName = data.aRecord;

  if (isIP) {
    if (!aRecordName) {
      aRecordName = "mc-" + crypto.randomUUID().slice(0, 6) + "." + base;

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

    finalTarget = aRecordName;
  }

  const srvName = `_minecraft._tcp.${sub}.${base}`;

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

  await env.MC_KV.put(
    key,
    JSON.stringify({
      ...data,
      target: finalTarget,
      port: newPort,
      aRecord: isIP ? finalTarget : null
    })
  );

  return { success: true };
}
