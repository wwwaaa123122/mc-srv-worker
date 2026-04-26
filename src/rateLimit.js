export async function rateLimitCheck(env, ip) {
  const key = `rate:${ip}`;
  const current = await env.MC_KV.get(key);

  const limit = parseInt(env.RATE_LIMIT || "5");

  if (!current) {
    await env.MC_KV.put(key, "1", { expirationTtl: 60 });
    return true;
  }

  const count = parseInt(current);

  if (count >= limit) return false;

  await env.MC_KV.put(key, String(count + 1), {
    expirationTtl: 60
  });

  return true;
}
