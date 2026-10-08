# MC 免端口域名生成器

基于 Cloudflare Workers 的 Minecraft 免端口域名服务。通过自动创建 **SRV 记录**，让你的 Minecraft 服务器玩家无需手动输入端口号，直接通过域名即可连接。

## 工作原理

Minecraft Java 版默认连接端口为 `25565`，但许多服务器使用了非标准端口。本项目利用 Cloudflare DNS 的 SRV 记录，将 `你的名字.example.com` 自动指向你实际的服务器地址和端口。玩家在游戏中只需输入 `你的名字.example.com` 即可连接，无需记忆端口号。

如果目标是 IP 地址，系统会自动创建一个 A 记录指向该 IP，SRV 记录再指向这个 A 记录（因为 Cloudflare 的 SRV 记录不支持直接填写 IP）。

## 论坛账号系统

本服务已接入 [星辰旅人论坛](https://forum.182030.xyz) 的账号系统（后端 `i.182030.xyz`）：

- **登录方式**：页面内直接使用论坛的用户名（或邮箱）+ 密码登录；生产环境论坛登录带 Turnstile 人机验证，本页面会自动渲染论坛的验证组件。凭证（Access/Refresh Token）只保存在浏览器 localStorage。
- **验签方式**：Worker 通过论坛公开的 `/.well-known/jwks.json`（RS256）本地验签，不与论坛共享任何密钥；校验 `iss` / `aud` / `exp` / `typ=access`。
- **登录后**：创建的域名自动绑定到论坛账号；修改/删除**无需授权码**；创建**免人机验证**（身份由论坛账号保证）；「我的域名」面板统一管理；每账号默认上限 10 个（`USER_RECORD_LIMIT`）。
- **认领历史域名**：登录前（匿名）创建的域名，可在「我的域名 → 认领历史域名」用 前缀 + 授权码 绑定到当前账号。
- **匿名使用**：不登录也可以继续用「创建 + 授权码管理」的原有方式，行为与从前完全一致。
- **令牌续期**：Access Token 30 分钟，前端在过期前用 Refresh Token 自动轮换；登出会撤销论坛侧会话链。

## 项目结构

```
├── src/
│   ├── index.js        # Workers 入口，路由分发
│   ├── dns.js          # 创建 DNS 记录（A + SRV）
│   ├── update.js       # 更新已有记录
│   ├── delete.js       # 删除记录
│   ├── auth.js         # 授权码生成与验证
│   ├── rateLimit.js    # IP 级别速率限制
│   ├── validator.js    # 输入校验（地址 / 前缀）
│   ├── turnstile.js    # Cloudflare Turnstile 人机验证（服务端校验）
│   ├── ipGuard.js      # 目标地址黑名单（内网 / 公共服务地址）
│   ├── forum-auth.js   # 论坛账号系统接入（JWT RS256 + JWKS 验签）
│   ├── user-records.js # 论坛用户绑定的域名记录索引（KV）
│   └── utils.js        # 工具函数
├── public/
│   ├── index.html      # 前端页面
│   ├── style.css       # 页面样式
│   └── app.js          # 前端交互逻辑（含论坛登录 / 我的域名）
├── scripts/
│   └── smoke-test.sh   # 本地冒烟测试（全链路）
├── wrangler.toml       # Workers 配置
└── README.md
```

## 前置条件

1. 一个 [Cloudflare](https://dash.cloudflare.com) 账号
2. 域名托管在 Cloudflare
3. API Token（**编辑 DNS** 权限，仅需目标域名所在区域）

## 部署

### 1. 配置 `wrangler.toml`

```toml
name = "mc-srv-worker"
main = "src/index.js"
compatibility_date = "2025-08-11"

[[kv_namespaces]]
binding = "MC_KV"
id = "你的KV命名空间ID"

[vars]
CF_API_TOKEN = ""    # Cloudflare API Token
CF_ZONE_ID = ""       # 域名区域ID（域名概览页面底部）
BASE_DOMAIN = "你的域名"  # 例如 example.com
RATE_LIMIT = "5"      # 每IP每分钟最大创建次数

[assets]
directory = "./public"
binding = "ASSETS"
```

### 2. 创建 KV 命名空间

```bash
npx wrangler kv:namespace create MC_KV
```

将返回的 `id` 填入 `wrangler.toml`。

### 3. 发布

```bash
npx wrangler deploy
```

### 4. 配置环境变量（可选）

`CF_API_TOKEN` / `GUARD_SECRET` / `TURNSTILE_SECRET` 等敏感值建议放在 Cloudflare 面板（或 Secret），不要写进本仓库（仓库为公开仓库）：

```bash
npx wrangler secret put CF_API_TOKEN
```

> 注意：`wrangler.toml` 已开启 `keep_vars = true`，`npx wrangler deploy` 不会清掉只存在
> 于 Dashboard 的变量/Secret；生产当前即采用该方式保存敏感配置。

## 本地开发与冒烟测试

```bash
npx wrangler dev --port 8788          # .dev.vars：FORUM_* 指向本地论坛、DRY_RUN=true
```

需要同时跑一个论坛后端本地 dev（`../forum-worker/backend`，端口 8787，`.dev.vars` 里
`TURNSTILE_DISABLED=true`）。然后：

```bash
bash scripts/smoke-test.sh            # 38 项全链路断言（匿名/登录/绑定/认领/配额/删除）
```

## API 接口

### 创建域名

```
POST /api/create
Content-Type: application/json

{
  "address": "你的服务器地址:端口号",
  "prefix": "自定义前缀（可选）"
}
```

可选请求头 `Authorization: Bearer <论坛 Access Token>`：携带有效论坛 Token 时创建的域名
绑定到该账号（`"bound": true`），免人机验证，且不再强制授权码管理。

成功响应：

```json
{
  "success": true,
  "domain": "前缀.你的域名",
  "authCode": "16位授权码",
  "bound": false
}
```

### 我的域名（需论坛登录）

```
GET /api/my/records
Authorization: Bearer <论坛 Access Token>

→ { "success": true, "records": [{ "sub", "domain", "target", "port", "created" }] }
```

### 认领历史域名（需论坛登录）

```
POST /api/claim
Authorization: Bearer <论坛 Access Token>

{ "sub": "前缀", "authCode": "该记录的授权码" }

→ { "success": true, "record": { ... } }
```

### 修改解析

```
POST /api/update
Content-Type: application/json

{
  "sub": "前缀",
  "target": "新地址",
  "port": 新端口号,
  "authCode": "授权码（属主已登录时可省略）"
}
```

### 删除解析

```
POST /api/delete
Content-Type: application/json

{
  "sub": "前缀",
  "authCode": "授权码（属主已登录时可省略）"
}
```

## 使用流程

1. 打开部署后的页面
2. 输入 `服务器地址:端口号`（例如 `play.example.com:25565` 或 `1.2.3.4:25565`）
3. 可选输入自定义前缀，不填则自动生成
4. 点击「生成域名」，获得形如 `mc-abc123.你的域名` 的域名和授权码
5. 玩家在 Minecraft 中直接输入该域名即可连接

## 说明

- 每个域名创建后会生成一个 **授权码**，修改或删除时需要提供该授权码，请妥善保存
- 每 IP 每分钟有创建次数限制（默认 5 次），防止滥用
- 目标地址的格式必须为 `host:port`
- 端口范围：`1` ~ `65535`
