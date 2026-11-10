# OmniTask 后端 — Cloudflare Containers 镜像
# 上下文为仓库根（wrangler 在根目录读取本 Dockerfile），只复制 server/。
FROM node:20-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
# 先复制依赖与 prisma schema，让 npm ci 的缓存层命中
COPY server/package.json server/package-lock.json ./
COPY server/prisma ./prisma
RUN npm ci --ignore-scripts \
 && npx prisma generate --schema prisma/schema.prisma \
 && npx prisma generate --schema prisma/schema-user.prisma \
 && npx prisma generate --schema prisma/schema-conversation.prisma \
 && npx prisma generate --schema prisma/schema-knowledge.prisma \
 && npx prisma generate --schema prisma/schema-overflow.prisma \
 && npx prisma generate --schema prisma/schema-agent.prisma
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build
EXPOSE 3001
ENV PORT=3001
CMD ["node", "dist/index.js"]
