/**
 * 用户绑定的解析记录索引。
 *
 * KV 主存储仍是 <sub> → 记录 JSON（与历史数据完全兼容）；
 * 另写一份索引 uid:<论坛用户id>:<sub> → 记录快照，用于：
 *   - 「我的域名」列表（KV list 按 uid 前缀枚举）
 *   - 每用户配额统计（USER_RECORD_LIMIT）
 *
 * 一致性约定：绑定/换绑/解绑时主记录与索引同时写/删；
 * 匿名删除他人通过授权码删除已绑定记录时，也会顺带清理索引。
 */

const USER_INDEX_PREFIX = "uid:";

export function indexKeyFor(uid, sub) {
  return `${USER_INDEX_PREFIX}${uid}:${sub}`;
}

export function baseDomain(env) {
  return String(env.BASE_DOMAIN || "").replace(/^\.+/, "");
}

/** 记录快照（索引用，冗余存储避免逐条回查主记录） */
export function snapshotOf(record, sub, base) {
  return {
    sub,
    domain: `${sub}.${base}`,
    target: record.target,
    port: record.port,
    created: record.created || null,
    bound: true
  };
}

/** 写索引（不改动主记录；主记录由 createDNSRecords / updateDNS 落盘） */
export async function writeIndex(env, uid, sub, record) {
  await env.MC_KV.put(indexKeyFor(uid, sub), JSON.stringify(snapshotOf(record, sub, baseDomain(env))));
}

/** 移除索引（存在才删） */
export async function removeIndex(env, uid, sub) {
  await env.MC_KV.delete(indexKeyFor(uid, sub));
}

/** 把主记录绑定到用户（写 user_id + 索引） */
export async function bindUser(env, uid, sub, record) {
  const base = baseDomain(env);
  const bound = { ...record, user_id: uid };
  await env.MC_KV.put(sub, JSON.stringify(bound));
  await env.MC_KV.put(indexKeyFor(uid, sub), JSON.stringify(snapshotOf(bound, sub, base)));
  return bound;
}

/** 用户当前绑定记录数 */
export async function countUserRecords(env, uid) {
  const list = await env.MC_KV.list({ prefix: `${USER_INDEX_PREFIX}${uid}:` });
  return list.keys.length;
}

/**
 * 列出用户绑定的全部记录（索引快照 + 主记录合并，主记录为准）。
 * 返回 [{ sub, domain, target, port, created, claimed }]
 */
export async function listUserRecords(env, uid) {
  const base = baseDomain(env);
  const list = await env.MC_KV.list({ prefix: `${USER_INDEX_PREFIX}${uid}:` });
  const records = [];
  for (const key of list.keys) {
    const sub = key.name.slice((`${USER_INDEX_PREFIX}${uid}:`).length);
    if (!sub) continue;
    const raw = await env.MC_KV.get(sub);
    if (raw) {
      try {
        const rec = JSON.parse(raw);
        records.push({
          sub,
          domain: `${sub}.${base}`,
          target: rec.target,
          port: rec.port,
          created: rec.created || null
        });
        continue;
      } catch {
        // 主记录损坏时退回索引快照
      }
    }
    const snapRaw = await env.MC_KV.get(key.name);
    if (snapRaw) {
      try {
        const snap = JSON.parse(snapRaw);
        records.push({
          sub: snap.sub || sub,
          domain: snap.domain || `${sub}.${base}`,
          target: snap.target,
          port: snap.port,
          created: snap.created || null
        });
      } catch {
        // 忽略损坏的索引条目
      }
    }
  }
  records.sort((a, b) => (b.created || 0) - (a.created || 0));
  return records;
}
