# Dockerfile (最终生产版本 - 已修正网络和 OpenSSL 问题)

# 使用一个包含完整构建工具的镜像
FROM node:20-slim

# 替换 Debian 软件源为阿里云镜像，解决 apt-get update 卡顿问题
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources

# [可选优化] 明确安装 openssl 以消除 Prisma 警告
RUN apt-get update && apt-get install -y openssl

WORKDIR /usr/src/app

COPY package*.json ./

# 切换到速度更快的淘宝 NPM 镜像源
RUN npm config set registry https://registry.npmmirror.com
# 安装所有依赖
RUN npm install

COPY . .

RUN npx prisma generate

# 构建 NestJS 应用
RUN npm run build

# 使用专门的配置文件来编译 seed 脚本
RUN npx tsc --project tsconfig.seed.json

# 复制并设置启动脚本权限
COPY entrypoint.sh .
RUN chmod +x ./entrypoint.sh

# 暴露端口
EXPOSE 9527

# 设置启动命令
CMD ["./entrypoint.sh"]