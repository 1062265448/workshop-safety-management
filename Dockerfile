# ============================================================
# 成品车间安全管理系统 · 一体化镜像
# 单容器包含：前端打包产物 + 后端服务（托管前端静态文件）
# 数据库使用独立的 postgres 容器（见 docker-compose.prod.yml）
# ============================================================

# ---------- 阶段一：前端构建 ----------
FROM node:20-alpine AS app-build
WORKDIR /build/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

# ---------- 阶段二：后端构建 ----------
FROM node:20-alpine AS backend-build
WORKDIR /build/backend
# prisma generate 需要探测 OpenSSL 版本以选择正确的引擎
RUN apk add --no-cache openssl
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
# 生成 Prisma Client（运行时引擎随 node_modules 一起带入最终镜像）
RUN npx prisma generate && npm run build

# ---------- 阶段三：运行时 ----------
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/backend

# Prisma 引擎运行依赖 OpenSSL（alpine 精简镜像默认不带）
RUN apk add --no-cache openssl libc6-compat

# 后端运行所需：dist 产物、全部依赖（含 prisma CLI 用于启动时 migrate deploy）、迁移脚本
COPY --from=backend-build /build/backend/node_modules ./node_modules
COPY --from=backend-build /build/backend/dist ./dist
COPY --from=backend-build /build/backend/prisma ./prisma
COPY --from=backend-build /build/backend/package.json ./package.json

# 前端产物：app.module.ts 中静态路径为 join(__dirname, '..', '..', 'app', 'dist')
# __dirname = /app/backend/dist → 解析为 /app/app/dist，此布局不可改动
COPY --from=app-build /build/app/dist /app/app/dist

# 上传的照片落盘在 process.cwd()/uploads = /app/backend/uploads（compose 挂载卷持久化）
RUN mkdir -p /app/backend/uploads

EXPOSE 3100
# 启动时自动执行数据库迁移，然后启动服务
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
