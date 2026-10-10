# 车间安全管理系统

**成品车间**隐患排查治理闭环系统：多渠道录入（PPT / 文档 / 手动）→ 标签化管理 → 整改闭环 → 防复发三次复查 → 周期统计 → 定时提醒。
其他车间（厂督察通报中）的问题仅作参考存档，不进入整改闭环与提醒，但可在统计页单独查看（用于观察厂督察近期检查重点）。

设计解析见 [设计文档.md](设计文档.md)；完整过程见 [开发日志.md](开发日志.md)；操作说明见 [使用手册.md](使用手册.md)。

## 目录

```
app/        前端（React 19 + Vite + Tailwind，iOS 亮色风格）
backend/    后端（NestJS + Prisma）
docker-compose.yml  PostgreSQL 16（Docker Desktop）
```

## 启动

```bash
# 1. 数据库（Docker Desktop 需运行；项目名必须显式指定，目录名含中文）
docker-compose -p wsms up -d

# 2. 后端 API（http://localhost:3100/api）
cd backend
npm install
npx prisma migrate dev   # 首次
node dist/seed.js        # 首次灌入内置标签与检查计划
npm run build && npm start     # 或 npm run dev

# 3. 前端（http://localhost:7100）
cd app
npm install
npm run dev
```

## 登录鉴权

- JWT 认证：后端全局守卫，除 `POST /api/auth/login` 外所有 API 需携带 `Authorization: Bearer <token>`，token 有效期 7 天
- 管理员账号：首次运行 `node dist/seed.js` 时自动创建——用户名取环境变量 `ADMIN_USERNAME`（默认 `wsms_admin`），密码取 `ADMIN_PASSWORD`；两者都未配置时生成强随机密码并打印一次到控制台（请立即记录并登录后修改）。系统中不存在任何内置默认口令
- 密钥在 `backend/.env` 的 `JWT_SECRET`，生产环境务必更换
- 用户表 `users`（用户名 / 密码 bcrypt 哈希 / 角色 admin|safety_officer|viewer）

## 开机自启（已配置）

开机后无需任何手动操作：启动文件夹中的 `WSMS-AutoStart.vbs` 会静默调用根目录 `wsms-autostart.bat`，依序自动完成——①确保 Docker Desktop 运行 → ②拉起数据库容器（wsms-postgres）→ ③启动后端（3100，托管前端）→ ④启动 Cloudflare Tunnel（外网恢复）。每一步都有守卫判断，已在运行则跳过，不会重复拉起。

注意：自启后会留下两个最小化的命令行窗口——`WSMS-Backend`（后端）和 `WSMS-Tunnel`（隧道），请勿关闭；其他操作均无需接触。

**日常一键重启**：双击根目录 `重启服务.bat`——自动停掉 3100 端口旧进程 → 拉起数据库容器 → 新窗口启动后端（前端为静态产物随后端一并生效，无需单独重启；若改了前端代码需先 `cd app && npm run build` 再双击）。

```bash
# 1. 启动数据库
docker-compose -p wsms up -d

# 2. 打包前端 + 启动后端（后端会托管 app/dist）
cd app && npm run build && cd ..
cd backend && npm run build && npm start
```

然后局域网内其他电脑访问：`http://<本机IP>:3100`（当前本机 IP：`192.168.10.152`，IP 可能随网络变化，用 `ipconfig` 再确认；建议路由器后台绑定固定 IP）。

防火墙放行（右键"以管理员身份运行"命令提示符执行一次，已配置）：

```
netsh advfirewall firewall add rule name="WSMS-3100" dir=in action=allow protocol=TCP localport=3100
```

注意：数据库容器（5432）无需也不应对外暴露，后端已在本机连接。

## 互联网外网访问

工厂内部系统不建议直接暴露公网。推荐用 **Tailscale 组网**（零端口暴露、设备级加密），步骤：

1. **本机安装**：运行工作区里的 `tailscale-setup-amd64.msi`（已下载好，需管理员权限）
2. **注册登录**：装好后点任务栏 Tailscale 图标 → Log in，用 Google / Microsoft / GitHub 账号注册（免费版足够）
3. **查本机虚拟 IP**：命令行 `tailscale ip -4`，得到 `100.x.x.x` 地址
4. **启动本系统**：`docker-compose -p wsms up -d` + `cd backend && npm start`
5. **手机/其他电脑**：装 Tailscale 客户端登录同一账号，浏览器访问 `http://100.x.x.x:3100`
6. 建议：Tailscale 管理后台（login.tailscale.com）→ Machines → 本机 → **Disable key expiry**（否则 180 天要重登）；开启 MagicDNS 后可直接用机器名访问

当前生产环境已使用 **Cloudflare Tunnel**（隧道 `jcn-server`），公网地址：`https://wsms.jcngcp.xyz`（出站连接，无需公网 IP/端口映射，HTTPS 由 Cloudflare 提供；隧道进程由开机自启脚本维护）。

## 服务器部署（生产 · Docker 一体化）

系统已容器化，迁移到服务器一条命令拉起（应用 + PostgreSQL）：

```bash
cp env.prod.example .env.prod   # 填写强 JWT_SECRET 与数据库密码
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker exec wsms-app node dist/seed.js   # 首次全新部署：初始化管理员与检查计划
```

启动时自动执行数据库迁移，无需手动建表；数据库不暴露公网（仅容器内网）。
完整步骤（HTTPS 反代、数据迁移、备份回滚、故障排查）见 **[部署文档.md](部署文档.md)**。

> 公网部署后第一件事：登录并修改 admin 默认密码。

## API 概览

| 资源 | 端点 |
|------|------|
| 隐患 | `GET/POST /api/issues`、`GET/PATCH/DELETE /api/issues/:id`、`POST /api/issues/batch`（导入暂存区批量入库），支持 `?status=&categoryId=&locationId=&q=` 筛选 |
| 标签 | `GET/POST /api/tags`、`PATCH/DELETE /api/tags/:id`（内置标签不可删，删除自动清理引用） |
| 检查计划 | `GET/POST /api/plans`、`PATCH/DELETE /api/plans/:id` |
| 提醒 | `GET /api/reminders`、`POST /api/reminders/refresh`（幂等派生：整改超期 + 计划到点）、`PATCH /api/reminders/:id/read|done` |

## 数据库

- PostgreSQL 16，容器 `wsms-postgres`，端口 5432
- 库 `workshop_safety`，账号 `wsms` / `wsms_dev_2026`（开发口令，见 `backend/.env`）
- 表：`issues`、`tags`、`inspection_plans`、`reminders`（Prisma 迁移管理，`backend/prisma/`）

## 当前状态与下一步

- 前端已切换到后端 API（Vite 代理 `/api` → `localhost:3100`），所有读写直连 PostgreSQL；后端不可达时页面顶部会显示提示条
- 文档解析已实装（浏览器本地解析，文件不出本机）：
  - **PPTX**（`parsePptx.ts`）：按督查通报/三违通报格式识别问题页（"不符合《/存在…风险、隐患、漏洞/现场纠偏"句式，兼识别管理批评措辞页"不认真、不仔细/流于形式/不到位/未排查出"——536 期酒精检测漏查验、539 期排查流于形式两页靠此捕获），提取车间、发现时间、图片说明标题，关键词推测类型与风险等级；支持一页多问题拆分（"存在问题：1.…；2.…"）；三违通报自动归"违章作业"类
  - **未识别页提示**：既非问题页也非复查页的页面逐页记录页码/原因/内容预览，导入暂存区顶部可展开核对（封面、排班会、落实类等正面记录页属正常跳过），防止通报换句式后漏识别
  - **复查核销页识别**：解析"复查厂安全督查通报第 N 期…经查，整改核销属实"页面 → 暂存区核销分区，`matchReview.ts` 按"车间一致 + 描述片段 bigram 重合度 ≥ 0.45"在库中未闭环隐患里模糊匹配，确认后自动闭环（closedAt 取复查时间，fixNote 记核销依据）；未命中仅作记录
  - **DOCX**（`parseDocx.ts`）：mammoth 提取段落，同句式识别
  - **XLSX**（parseXlsx.ts）：SheetJS 按表头映射（标题/描述/区域/类型/等级）
  - 暂存区确认后批量入库，整改期限按风险等级默认（重大 3 天 / 较大 7 天 / 一般 15 天）
- 已用 8 份真实通报验证（厂督察通报/，经 `test-skip-pages.cjs` 回归脚本逐页核对）：525 期 7 条、535 期 10 条（含一页双问题拆分）、536 期 8 条、537/538/540 期各 7-8 条、539 期 7 条（含成品车间隐患正确判为纳入闭环）、三违统计 8 条全识别；核销闭环已实测（535 期复查页命中 522 期隐患并自动闭环）
- 导入自动建档：解析出的车间/类型名与标签库匹配，未命中时经 `POST /api/tags/ensure`（upsert 幂等）自动创建区域/类型标签并关联
- 检查计划闭环：`POST /api/plans/:id/complete` 记执行台账（执行人/备注/关联隐患）→ 按频率自动推进下一周期（自动补跳已过去的周期）→ 清理该计划提醒；前端计划页"完成本次检查"一键操作
- 管理范围界定：隐患 `scope` 字段区分 `managed`（成品车间，走整改闭环/统计/超期提醒）与 `reference`（其他车间，仅存档参考）；导入时按车间名自动判定，问题库分"成品车间 / 其他车间（参考）"页签
- 响应式 + PWA：移动端顶栏 + 抽屉导航（`lg` 断点切换桌面侧边栏，抽屉内含提醒中心/修改密码/退出登录），表单栅格移动端单列自适应；`manifest.webmanifest` + Service Worker（页面导航 network-first 保证更新即时生效，带哈希静态资源 cache-first、`/api` 不缓存）+ 盾牌图标，可"添加到主屏幕"当 App 用，仅生产构建生效
- 交互加固（全页面巡检后）：隐患/检查计划删除改为两段式内联确认（点垃圾桶 → 3 秒内再点红色"确认删除"才生效，不依赖原生 confirm，兼容内嵌浏览器）；标签管理重复名称前端即提示「xxx」已存在（后端 (name,group) 唯一约束兜底）；store 请求失败统一置 offline 显示顶部提示条并自动重连重试，按钮操作不再静默失败；问题库点击标题弹出详情层（完整描述/时间线/整改记录/照片管理/状态流转一体，支持直接编辑标题/描述/类型/区域/风险/期限/责任人/整改记录，留空字段发 null 清空）
- 隐患照片：手动录入可附现场照片（最多 9 张、单张 ≤ 10MB，本地预览后随提交上传）；问题库卡片显示缩略图，点开大图可翻页/两段式确认删除，卡片上的虚线框可随时补传整改照片；`POST /api/uploads`（multipart，仅图片类型）落盘 `backend/uploads/`，经 `/uploads/*` 静态访问（静态注册顺序：/uploads 必须先于 SPA 通配回退；Service Worker 对 /uploads 不缓存），迁移服务器时随 `backend/` 整体拷贝
- 通报照片自动提取：导入 PPTX 时按 `<a:blip r:embed>` 版面顺序提取每页照片（rels 映射 → ppt/media，过滤 <8KB 图标与 <100px 小图）；单问题页全部归入该隐患，多问题页按顺序均匀分配；复查页照片作为整改后照片，核销确认时追加到命中隐患；暂存区可见每条的照片数与缩略图
- 周期统计：范围页签（成品车间 / 其他车间 / 全部），其他车间视图直观呈现厂督察近期检查重点；类型分布饼图标签外置扇形旁；区域分布按数量降序、`interval={0}` + 高度自适应保证所有区域名完整显示；按期闭环率口径：整改期限落在期内的隐患中已闭环占比（参考件无期限不显示）
- 防复发复查：成品车间隐患默认要求 3 次复查、间隔 7 天（详情层可按隐患编辑间隔，PATCH `recheckIntervalDays`）；`POST /api/issues/:id/recheck` 记一次完成；提醒派生新增 recheck 类型——`foundAt + 第N次 × 间隔` 到点即生成"防复发复查（第 N/3 次）"提醒（refId 为 `隐患id#N`），完成复查自动清理对应提醒
- 参考标注（/annotations）：逐条评估其他车间参考件对成品车间的参考意义——三级分级（需严格注意/对照自查/一般了解）+ 成品车间相似点 + 严格注意事项；`issue_annotations` 表一隐患一条（`PUT /api/annotations/:issueId` upsert 幂等，隐患删除级联清理）；问题库参考件卡片显示标注等级徽标（悬停可见相似点与注意事项），标注页支持 全部/未标注/已标注/需严格注意 筛选与进度统计
- 下一步：统计分析增强（闭环率按区域/类型交叉）；服务器迁移后的网络配置（局域网/Tailscale 暴露）
