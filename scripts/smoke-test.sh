#!/usr/bin/env bash
# =============================================================================
# mc-srv-worker 本地冒烟测试
#
# 前置条件：
#   1. 论坛后端本地 dev：cd ../forum-worker/backend && npx wrangler dev --port 8787
#      （.dev.vars 需 TURNSTILE_DISABLED=true；建议加
#        ALLOWED_ORIGINS="http://127.0.0.1:8788,http://localhost:8788"）
#   2. 本 Worker 本地 dev：npx wrangler dev --port 8788
#      （.dev.vars：FORUM_* 指向 8787、DRY_RUN=true、TURNSTILE_ENABLED=false、
#        USER_RECORD_LIMIT=3）
#
# 用法：bash scripts/smoke-test.sh
# =============================================================================
set -u

SRV_URL="${SRV_URL:-http://127.0.0.1:8788}"
FORUM_URL="${FORUM_URL:-http://127.0.0.1:8787}"
ORIGIN="${ORIGIN:-http://127.0.0.1:8788}"
RUN_TAG="$$"          # 每轮唯一，避免跨轮数据污染
# 固定测试账号（注册一次，后续轮次直接登录，避免触发论坛注册限流）
U1_USER="${U1_USER:-smk-smoke-u1}"
U2_USER="${U2_USER:-smk-smoke-u2}"
U_PASS="${U_PASS:-smoke-test-12345}"

PASS=0
FAIL=0
declare -a FAILED_CASES=()

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    PASS=$((PASS + 1)); echo "  ✔ $name"
  else
    FAIL=$((FAIL + 1)); FAILED_CASES+=("$name"); echo "  ✘ $name"
    echo "    期望包含: $needle"
    echo "    实际: $(echo "$haystack" | head -c 300)"
  fi
}

assert_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    PASS=$((PASS + 1)); echo "  ✔ $name"
  else
    FAIL=$((FAIL + 1)); FAILED_CASES+=("$name"); echo "  ✘ $name"
    echo "    期望不包含: $needle"
  fi
}

jget() { # jget <json> <python表达式>
  python3 -c "
import json,sys
try:
    data = json.loads(sys.argv[1])
    print(eval(sys.argv[2]))
except Exception:
    print('')" "$1" "$2" 2>/dev/null
}

# 测试凭证缓存：access token 30 分钟有效，重复跑测试时直接复用，
# 避免每轮都打论坛登录接口触发限流（login 10 次 / 10 分钟）。
cache_file() { echo "${TMPDIR:-/tmp}/.mc-smoke-auth-$1.json"; }

token_exp() { # token_exp <accessToken> → exp（秒）
  printf '%s' "$1" | python3 -c "
import sys,base64,json
try:
    p = sys.stdin.read().strip().split('.')[1]
    p += '=' * (-len(p) % 4)
    print(json.loads(base64.urlsafe_b64decode(p)).get('exp', 0))
except Exception:
    print(0)" 2>/dev/null
}

ensure_user() { # ensure_user <username> → 输出 accessToken
  local u="$1" cf r t exp now rt nt
  cf="$(cache_file "$u")"

  t=$(jget "$(cat "$cf" 2>/dev/null)" "data['accessToken']")
  exp=$(token_exp "$t")
  now=$(date +%s)
  if [[ -n "$t" && "$exp" -gt $((now + 120)) ]]; then
    echo "$t"; return   # 缓存凭证仍有效
  fi

  # 缓存过期：用缓存的 refresh token 轮换（论坛侧 rotation 链）
  rt=$(jget "$(cat "$cf" 2>/dev/null)" "data['refreshToken']")
  if [[ -n "$rt" ]]; then
    r=$(curl -s -X POST -H "Content-Type: application/json" \
      -d "{\"refreshToken\":\"$rt\"}" "$FORUM_URL/api/auth/refresh")
    nt=$(jget "$r" "data['accessToken']")
    if [[ -n "$nt" ]]; then
      printf '%s' "$r" > "$cf"
      echo "$nt"; return
    fi
  fi

  # 无缓存/轮换失败：注册（仅首轮）→ 登录
  t=$(fresh_login "$u")
  if [[ -n "$t" ]]; then
    ENSURE_FRESH_LOGIN=1
  fi
  echo "$t"
}

# 强制重建凭证链（注册→登录，覆盖缓存）。用于链被撤销/重放失效后的自愈
fresh_login() { # fresh_login <user> → accessToken
  local u="$1" cf r t
  cf="$(cache_file "$u")"
  r=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "{\"username\":\"$u\",\"password\":\"$U_PASS\",\"email\":\"$u@example.com\",\"nickname\":\"冒烟测试\"}" \
    "$FORUM_URL/api/auth/register")
  t=$(jget "$r" "data['accessToken']")
  if [[ -z "$t" ]]; then
    r=$(curl -s -X POST -H "Content-Type: application/json" \
      -d "{\"identifier\":\"$u\",\"password\":\"$U_PASS\"}" "$FORUM_URL/api/auth/login")
    t=$(jget "$r" "data['accessToken']")
  fi
  if [[ -n "$t" ]]; then
    printf '%s' "$r" > "$cf"
  fi
  echo "$t"
}

# 尽力清空论坛本地 dev KV 的限流计数（仅本地！绝不触碰生产），避免连续跑测试被限流卡住
reset_local_rate_limits() {
  local forum_dir="${FORUM_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/../forum-worker/backend}"
  [[ -d "$forum_dir" ]] || return 0
  (
    cd "$forum_dir" && export WRANGLER_SEND_METRICS=false
    npx wrangler kv key list --binding CACHE --local 2>/dev/null | python3 -c "
import json,sys
try:
    for k in json.load(sys.stdin):
        if k['name'].startswith('rl:'):
            print(k['name'])
except Exception:
    pass" 2>/dev/null | while IFS= read -r k; do
      npx wrangler kv key delete --binding CACHE --local "$k" >/dev/null 2>&1
    done
  )
}

# 清空某账号名下的全部绑定记录（保证每轮确定性）
cleanup_user_records() { # cleanup_user_records <token>
  local t="$1" r subs
  r=$(curl -s -H "Authorization: Bearer $t" "$SRV_URL/api/my/records")
  subs=$(printf '%s' "$r" | python3 -c "
import json,sys
try:
    for rec in json.load(sys.stdin).get('records', []):
        print(rec.get('sub',''))
except Exception:
    pass" 2>/dev/null)
  for s in $subs; do
    curl -s -X POST -H "Content-Type: application/json" \
      -H "Authorization: Bearer $t" -d "{\"sub\":\"$s\"}" "$SRV_URL/api/delete" >/dev/null
  done
}

ENSURE_FRESH_LOGIN=0

echo "=============================================================="
echo " mc-srv-worker 冒烟测试"
echo "   worker: $SRV_URL"
echo "   forum : $FORUM_URL"
echo "   本轮标识: $RUN_TAG"
echo "=============================================================="

case "$FORUM_URL" in
  http://127.0.0.1:*|http://localhost:*) reset_local_rate_limits ;;
esac

# ---------- 0. 前置可用性 ----------
echo ""
echo "[0] 前置检查"
HEALTH=$(curl -s "$FORUM_URL/api/health")
assert_contains "论坛后端健康检查" "$HEALTH" '"status":"ok"'

PAGE=$(curl -s "$SRV_URL/")
assert_contains "首页包含论坛账号卡片" "$PAGE" "星辰旅人论坛账号"

# ---------- 1. 配置与 CORS ----------
echo ""
echo "[1] 站点配置 / CORS"
CFG=$(curl -s "$SRV_URL/api/config")
assert_contains "配置含论坛信息" "$CFG" '"forum"'
assert_contains "配置含论坛 apiBase" "$CFG" '"apiBase":"'"$FORUM_URL"'"'

CORS=$(curl -s -X OPTIONS -H "Origin: $ORIGIN" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  -D - -o /dev/null "$FORUM_URL/api/auth/login")
assert_contains "论坛 CORS 预检通过 (204)" "$CORS" "204"
CORS_LC=$(echo "$CORS" | tr '[:upper:]' '[:lower:]')
assert_contains "论坛 CORS 允许本站来源" "$CORS_LC" "access-control-allow-origin: $ORIGIN"

# ---------- 2. 匿名流程（原有行为回归） ----------
echo ""
echo "[2] 匿名流程"
R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"address":"play.example.com:25565"}' "$SRV_URL/api/create")
assert_contains "匿名自动前缀创建成功" "$R" '"success":true'
assert_contains "返回授权码" "$R" '"authCode"'
ANON_DOMAIN=$(jget "$R" "data['domain']")
ANON_SUB=${ANON_DOMAIN%%.*}
ANON_CODE=$(jget "$R" "data['authCode']")
echo "    （匿名记录: $ANON_DOMAIN / $ANON_CODE）"

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"address\":\"93.184.216.34:25565\",\"prefix\":\"smk-anon-$RUN_TAG\"}" "$SRV_URL/api/create")
assert_contains "匿名自定义前缀创建成功（IP 目标）" "$R" '"success":true'

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"address":"play.example.com:25565","prefix":"Bad Prefix!"}' "$SRV_URL/api/create")
assert_contains "非法前缀被拒绝 (400)" "$R" "前缀仅支持"

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"address\":\"play.example.com:25565\",\"prefix\":\"$ANON_SUB\"}" "$SRV_URL/api/create")
assert_contains "重复前缀被拒绝 (409)" "$R" "已被占用"

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"address":"1.1.1.1:25565"}' "$SRV_URL/api/create")
assert_contains "公共服务地址黑名单生效" "$R" "禁止创建解析"

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"sub\":\"$ANON_SUB\",\"target\":\"play2.example.com\",\"port\":25566,\"authCode\":\"wrong-code\"}" \
  "$SRV_URL/api/update")
assert_contains "匿名修改：授权码错误被拒绝" "$R" "授权码错误"

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"sub\":\"$ANON_SUB\",\"target\":\"play2.example.com\",\"port\":25566,\"authCode\":\"$ANON_CODE\"}" \
  "$SRV_URL/api/update")
assert_contains "匿名修改：正确授权码成功" "$R" '"success":true'

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"sub\":\"$ANON_SUB\",\"target\":\"play3.example.com\",\"port\":25567}" "$SRV_URL/api/update")
assert_contains "匿名修改：缺少授权码被拒绝" "$R" "请填写授权码，或先登录论坛账号"

# ---------- 3. 论坛账号注册与登录 ----------
echo ""
echo "[3] 论坛账号注册与登录"
U1_TOKEN=$(ensure_user "$U1_USER")
[[ -n "$U1_TOKEN" ]] && { PASS=$((PASS+1)); echo "  ✔ 用户1 ($U1_USER) 就绪"; } \
  || { FAIL=$((FAIL+1)); FAILED_CASES+=("用户1就绪"); echo "  ✘ 用户1就绪失败"; }

# 登录端点本身：仅在本轮真实发生密码登录时断言（缓存命中时跳过，避免触发限流）
if [[ "$ENSURE_FRESH_LOGIN" == "1" ]]; then
  R=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "{\"identifier\":\"$U1_USER\",\"password\":\"$U_PASS\"}" "$FORUM_URL/api/auth/login")
  assert_contains "论坛账号密码登录成功" "$R" '"accessToken"'
else
  PASS=$((PASS+1)); echo "  ↷ 凭证缓存命中，跳过密码登录断言"
fi

U2_TOKEN=$(ensure_user "$U2_USER")
[[ -n "$U2_TOKEN" ]] && { PASS=$((PASS+1)); echo "  ✔ 用户2 ($U2_USER) 就绪"; } \
  || { FAIL=$((FAIL+1)); FAILED_CASES+=("用户2就绪"); echo "  ✘ 用户2就绪失败"; }

# 清理两个账号的历史记录，保证配额与列表断言可重复
cleanup_user_records "$U1_TOKEN"
cleanup_user_records "$U2_TOKEN"

R=$(curl -s -H "Authorization: Bearer $U2_TOKEN" "$SRV_URL/api/my/records")
assert_contains "用户2列表已清空" "$R" '"records":[]'

# ---------- 4. 账号绑定创建 / 我的域名 ----------
echo ""
echo "[4] 账号绑定创建 / 我的域名"
R=$(curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $U1_TOKEN" \
  -d "{\"address\":\"u1.example.com:25565\",\"prefix\":\"smk-u1a-$RUN_TAG\"}" "$SRV_URL/api/create")
assert_contains "登录创建成功且绑定账号" "$R" '"bound":true'
U1A_SUB=$(jget "$R" "data['domain']" | cut -d. -f1)
U1A_CODE=$(jget "$R" "data['authCode']")
echo "    （绑定记录: $U1A_SUB / $U1A_CODE）"

R=$(curl -s -H "Authorization: Bearer $U1_TOKEN" "$SRV_URL/api/my/records")
assert_contains "我的域名列表包含新记录" "$R" "$U1A_SUB"

# 配额（本地 USER_RECORD_LIMIT=3；用户2 已清理，确定性填满后断言第 4 条被拒）
for i in 1 2 3; do
  curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $U2_TOKEN" \
    -d "{\"address\":\"q$i.example.com:25565\",\"prefix\":\"smk-q-$RUN_TAG-$i\"}" "$SRV_URL/api/create" >/dev/null
done
R=$(curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $U2_TOKEN" \
  -d "{\"address\":\"q4.example.com:25565\",\"prefix\":\"smk-q-$RUN_TAG-4\"}" "$SRV_URL/api/create")
assert_contains "超出配额被拒绝 (409)" "$R" "已达上限"

# ---------- 5. 授权与归属校验 ----------
echo ""
echo "[5] 授权与归属"
R=$(curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $U2_TOKEN" \
  -d "{\"sub\":\"$U1A_SUB\",\"target\":\"evil.example.com\",\"port\":1}" "$SRV_URL/api/update")
assert_contains "非属主修改被拒绝" "$R" "授权码"

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $U2_TOKEN" \
  -d "{\"sub\":\"$U1A_SUB\"}" "$SRV_URL/api/delete")
assert_contains "非属主删除被拒绝" "$R" "授权码"

# 篡改签名：改写 token 末 2 位（确定性保证与原 token 不同）
TAMPERED="${U1_TOKEN:0:${#U1_TOKEN}-2}xx"
if [[ "$TAMPERED" == "$U1_TOKEN" ]]; then TAMPERED="${U1_TOKEN%?}A"; fi
R=$(curl -s -H "Authorization: Bearer $TAMPERED" "$SRV_URL/api/my/records")
assert_contains "篡改签名 Token 被拒绝 (401)" "$R" "AUTH_INVALID"

R=$(curl -s "$SRV_URL/api/my/records")
assert_contains "无 Token 访问我的域名被拒绝" "$R" "AUTH_REQUIRED"

# ---------- 6. 属主免授权码管理 ----------
echo ""
echo "[6] 属主免授权码管理"
R=$(curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $U1_TOKEN" \
  -d "{\"sub\":\"$U1A_SUB\",\"target\":\"u1-new.example.com\",\"port\":25570}" "$SRV_URL/api/update")
assert_contains "属主免授权码修改成功" "$R" '"success":true'

R=$(curl -s -H "Authorization: Bearer $U1_TOKEN" "$SRV_URL/api/my/records")
assert_contains "列表同步显示新目标" "$R" "u1-new.example.com"

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"sub\":\"$U1A_SUB\",\"target\":\"u1-legacy.example.com\",\"port\":25571,\"authCode\":\"$U1A_CODE\"}" \
  "$SRV_URL/api/update")
assert_contains "属主记录仍可用授权码管理（兼容）" "$R" '"success":true'

# ---------- 7. 认领历史记录 ----------
echo ""
echo "[7] 认领历史记录"
R=$(curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $U1_TOKEN" \
  -d "{\"sub\":\"$ANON_SUB\",\"authCode\":\"wrong\"}" "$SRV_URL/api/claim")
assert_contains "认领：授权码错误被拒绝" "$R" "授权码错误"

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $U1_TOKEN" \
  -d "{\"sub\":\"$ANON_SUB\",\"authCode\":\"$ANON_CODE\"}" "$SRV_URL/api/claim")
assert_contains "认领成功" "$R" '"success":true'

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $U2_TOKEN" \
  -d "{\"sub\":\"$ANON_SUB\",\"authCode\":\"$ANON_CODE\"}" "$SRV_URL/api/claim")
assert_contains "重复认领（他人账号）被拒绝" "$R" "ALREADY_BOUND"

R=$(curl -s -H "Authorization: Bearer $U1_TOKEN" "$SRV_URL/api/my/records")
assert_contains "认领后出现在我的域名" "$R" "$ANON_SUB"

# ---------- 8. Token 刷新链路 ----------
echo ""
echo "[8] Token 刷新"
try_refresh() { # try_refresh → 输出新 accessToken（空为失败），$R 为响应
  local rt=$(jget "$(cat "$(cache_file "$U1_USER")" 2>/dev/null)" "data['refreshToken']")
  R=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "{\"refreshToken\":\"$rt\"}" "$FORUM_URL/api/auth/refresh")
  jget "$R" "data['accessToken']"
}

U1_TOKEN2=$(try_refresh)
if [[ -z "$U1_TOKEN2" ]]; then
  # 链失效（如前一轮 TOKEN_REPLAY 撤销整链）：重新登录重建链后重试
  echo "    （凭证链失效，重建后重试）"
  U1_TOKEN=$(fresh_login "$U1_USER")
  U1_TOKEN2=$(try_refresh)
fi
[[ -n "$U1_TOKEN2" ]] && { PASS=$((PASS+1)); echo "  ✔ Refresh Token 轮换成功"; } \
  || { FAIL=$((FAIL+1)); FAILED_CASES+=("刷新"); echo "  ✘ 刷新失败: $R"; }

# 轮换产生的新凭证对写回缓存，避免下一轮重放已轮换的 Refresh Token（TOKEN_REPLAY）
if [[ -n "$U1_TOKEN2" ]]; then
  printf '%s' "$R" > "$(cache_file "$U1_USER")"
  U1_TOKEN="$U1_TOKEN2"
fi

R=$(curl -s -H "Authorization: Bearer $U1_TOKEN2" "$SRV_URL/api/my/records")
assert_contains "新 Access Token 可继续访问" "$R" '"success":true'

# ---------- 9. 删除与清理 ----------
echo ""
echo "[9] 删除与清理"
R=$(curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $U1_TOKEN2" \
  -d "{\"sub\":\"$U1A_SUB\"}" "$SRV_URL/api/delete")
assert_contains "属主免授权码删除成功" "$R" '"success":true'

R=$(curl -s -H "Authorization: Bearer $U1_TOKEN" "$SRV_URL/api/my/records")
assert_not_contains "删除后列表不再包含该记录" "$R" "$U1A_SUB"

R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"address\":\"d.example.com:25565\",\"prefix\":\"smk-del-$RUN_TAG\"}" "$SRV_URL/api/create")
DEL_SUB=$(jget "$R" "data['domain']" | cut -d. -f1)
DEL_CODE=$(jget "$R" "data['authCode']")
R=$(curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"sub\":\"$DEL_SUB\",\"authCode\":\"$DEL_CODE\"}" "$SRV_URL/api/delete")
assert_contains "匿名授权码删除成功（原有行为）" "$R" '"success":true'

echo ""
echo "=============================================================="
if [[ $FAIL -eq 0 ]]; then
  echo "✅ 冒烟测试全部通过：$PASS 项"
else
  echo "❌ 通过 $PASS 项，失败 $FAIL 项："
  for c in "${FAILED_CASES[@]}"; do echo "   - $c"; done
  exit 1
fi
