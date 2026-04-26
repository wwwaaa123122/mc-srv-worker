# MC 免端口域名生成器

基于 Cloudflare Workers 的 Minecraft 免端口域名服务。通过自动创建 **SRV 记录**，让你的 Minecraft 服务器玩家无需手动输入端口号，直接通过域名即可连接。

## 工作原理

Minecraft Java 版默认连接端口为 `25565`，但许多服务器使用了非标准端口。本项目利用 Cloudflare DNS 的 SRV 记录，将 `你的名字.example.com` 自动指向你实际的服务器地址和端口。玩家在游戏中只需输入 `你的名字.example.com` 即可连接，无需记忆端口号。

如果目标是 IP 地址，系统会自动创建一个 A 记录指向该 IP，SRV 记录再指向这个 A 记录（因为 Cloudflare 的 SRV 记录不支持直接填写 IP）。

## 项目结构

```
├── src/
│   ├── index.js        # Workers 入口，路由分发
│   ├── dns.js          # 创建 DNS 记录（A + SRV）
│   ├── update.js       # 更新已有记录
│   ├── delete.js       # 删除记录
│   ├── auth.js         # 授权码生成与验证
│   ├── rateLimit.js    # IP 级别速率限制
│   ├── validator.js    # 输入校验
│   └── utils.js        # 工具函数
├── public/
│   ├── index.html      # 前端页面
│   ├── style.css       # 页面样式
│   └── app.js          # 前端交互逻辑
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

可通过 Cloudflare 面板设置 `vars` 中的变量，避免明文写在 `wrangler.toml` 中：

```bash
npx wrangler secret put CF_API_TOKEN
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

成功响应：

```json
{
  "success": true,
  "domain": "前缀.你的域名",
  "authCode": "16位授权码"
}
```

### 修改解析

```
POST /api/update
Content-Type: application/json

{
  "sub": "前缀",
  "target": "新地址",
  "port": 新端口号,
  "authCode": "授权码"
}
```

### 删除解析

```
POST /api/delete
Content-Type: application/json

{
  "sub": "前缀",
  "authCode": "授权码"
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
