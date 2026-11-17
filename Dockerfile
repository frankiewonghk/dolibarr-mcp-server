# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3900 \
    MCP_DB_PATH=/data/dolibarr-mcp.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3900
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3900/healthz || exit 1
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
CMD ["http"]
