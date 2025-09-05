# Dockerfile (最终生产版本 - 完整修复版)

# --- 阶段 1: Builder ---
FROM node:20-slim AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx prisma generate

# 第 1 步: 构建 NestJS 应用
RUN npm run build

# 第 2 步: 使用专门的配置文件来编译 seed 脚本
RUN npx tsc --project tsconfig.seed.json

# 清理开发依赖
RUN npm prune --production

# --- 阶段 2: Production ---
FROM node:20-alpine
USER node
WORKDIR /home/node/app

# 从 builder 阶段复制最终需要的所有文件
COPY --from=builder --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=builder --chown=node:node /usr/src/app/dist ./dist
COPY --from=builder --chown=node:node /usr/src/app/entrypoint.sh .

# [核心修复] 将 prisma 文件夹 (包含 schema.prisma) 复制到最终镜像中
COPY --from=builder --chown=node:node /usr/src/app/prisma ./prisma

RUN chmod +x ./entrypoint.sh
EXPOSE 9527
CMD ["./entrypoint.sh"]