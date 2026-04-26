export async function createDNSRecords(env, sub, targetHost, port) {
  const base = env.BASE_DOMAIN;

  const headers = {
    Authorization: `Bearer ${env.CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(targetHost);

  const randomSub = "mc-" + crypto.randomUUID().slice(0, 6);
  const fullAName = `${randomSub}.${base}`;

  const authCode = crypto.randomUUID().replace(/-/g, "").slice(0, 16);

  let finalTarget = targetHost;

  if (isIP) {
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

    finalTarget = fullAName;
  }

  await env.MC_KV.put(
    sub,
    JSON.stringify({
      target: finalTarget,
      port,
      authCode,
      created: Date.now(),
      aRecord: isIP ? fullAName : null
    })
  );

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
    authCode
  };
}
