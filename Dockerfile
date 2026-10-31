FROM node:26-slim AS build
WORKDIR /app
# build tools for better-sqlite3 when no prebuilt binary matches (e.g. some ARM NAS)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data
# Starts as root only to fix ownership of a bind-mounted DATA_DIR, then runs as USERMAP_UID (default 1000).
ENV USERMAP_UID=1000 USERMAP_GID=1000
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
