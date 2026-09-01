# 血压 / 心率记录

一个部署在 **Cloudflare Workers + D1** 上的多用户血压 / 心率记录应用（架构：Workers + D1 + 静态资源 + Chart.js 前端）。

*   **需要登录**：会话 Cookie（HttpOnly、SameSite=Lax），密码以 PBKDF2-SHA256 加盐哈希存储。
*   **无注册、无用户管理**：用户由管理员手动写入数据库（`scripts/hash-password.mjs` 生成哈希）。
*   **多用户**：每位用户只能查看 / 修改自己的记录。

## 功能

*   登录 / 登出，会话有效期 30 天
*   **修改密码**：登录后在页面右上角「修改密码」即可自助修改（需验证当前密码，新密码至少 8 个字符；
    修改成功后除当前会话外的其他会话自动吊销）
*   添加 / 编辑 / 删除血压记录（收缩压、舒张压、心率、测量时间、备注）
*   趋势图：收缩压、舒张压、心率三条曲线（Chart.js），前端本地时区换算
*   血压自动分级（低血压 / 正常 / 正常高值 / 1级高血压 / ≥2级高血压，参考中国高血压防治指南）
*   按日期范围查询，默认最近 30 天
*   导出 CSV（Excel 可直接打开）

## 重置 / 修改密码

### 页面自助修改

登录后在页面右上角点击「修改密码」，验证当前密码后设置新密码（至少 8 个字符）。
修改成功后除当前会话外的其他会话会被自动吊销，用户需在新设备上重新登录。

### 命令行重置（用户忘记密码时由管理员执行）

```bash
# 生成 UPDATE SQL（同时吊销该用户所有现有会话）
node scripts/reset-password.mjs alice 'new-pass-123' > reset-password.sql
# 查看内容确认无误后执行（本地 / 远程任选其一）:
npx wrangler d1 execute bloodpressure --local  --file=reset-password.sql
npx wrangler d1 execute bloodpressure --remote --file=reset-password.sql
```

## 部署

```bash
# 1. 安装依赖
npm install

# 2. 创建数据库，并把输出的 database_id 填入 wrangler.jsonc
npx wrangler d1 create bloodpressure

# 3. 建表（本地开发用 --local，部署用 --remote）
npx wrangler d1 execute bloodpressure --remote --file=bloodpressure.sql

# 4. 预置用户（无注册页，只能手动写库）
node scripts/hash-password.mjs alice '你的密码' 爱丽丝 > seed-users.sql
# 查看 seed-users.sql 内容确认无误后执行：
npx wrangler d1 execute bloodpressure --remote --file=seed-users.sql

# 5. 部署
npm run deploy
```

## 本地开发

```bash
npm run dev          # 启动本地开发服务器（默认 http://localhost:8787）
npm test             # 运行 vitest 测试
```

本地开发时同样需要先执行建表和预置用户（把上面的 `--remote` 换成 `--local`），
本地数据库位于 `.wrangler/state/`，删除该目录可重置本地数据。

## 部署形态（支持两种 URL 同时访问）

代码同时兼容以下两种部署形态，无需分别打包：

| 形态 | 配置位置 | 访问 URL | 说明 |
| --- | --- | --- | --- |
| Custom Domain | Dashboard → Worker → Domains | `bloodpressure.example.com` | 首页 `/` 由 Cloudflare Assets 直接托管，`/api/*` 进 Worker |
| 子路径 Route | Dashboard → Worker → Routes | `example.com/bloodpressure*` | 首页由 Worker 剥掉 `/bloodpressure` 前缀后经 `env.ASSETS` 回退取回，API 同理 |

> 注意：子路径 Route 的 pattern **必须带 `*`**（如 `example.com/bloodpressure*`），
> 否则 `example.com/bloodpressure/api/*` 不会路由到本 Worker。
> 前端 `public/index.html` 的 `apiBase()` 会自动根据当前路径加上 `/bloodpressure` 前缀，无需手工改。

> 注：`package.json` 中通过 `overrides` 将 esbuild 固定为 0.25.12，
> 因为 0.28.x 的二进制在部分 Linux 环境下会段错误；其他环境如遇问题可移除此约束。

## 常用命令速查

| 操作 | 命令 |
| --- | --- |
| 生成用户插入 SQL | `node scripts/hash-password.mjs <用户名> <密码> [显示名]` |
| 重置用户密码（输出 UPDATE + 吊销会话 SQL） | `node scripts/reset-password.mjs <用户名> <新密码>` |
| 远程建表 | `npx wrangler d1 execute bloodpressure --remote --file=bloodpressure.sql` |
| 远程执行任意 SQL | `npx wrangler d1 execute bloodpressure --remote --command "SELECT * FROM users;"` |

## 安全说明

*   密码使用 PBKDF2-SHA256（10 万次迭代，每用户随机 16 字节盐），哈希格式
    `pbkdf2$迭代次数$盐(hex)$哈希(hex)`，校验时使用恒定时间比较。
*   会话 token 为 32 字节随机数，存于 HttpOnly Cookie，服务端存 D1 并可随时吊销（登出即删除）。
*   修改密码 / 管理员重置密码后会吊销该用户除当前会话外的所有会话，防止旧设备继续使用。
*   未提供登录限流与 HTTPS 强制（Cloudflare 默认支持 HTTPS）；如需更严格防护可自行扩展。
*   本项目仅适合小规模自用场景，请勿存放敏感数据或用于生产级健康系统。
