FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321 DB_PATH=/data/brandlens.db
COPY package.json tsconfig.json ./
COPY src ./src
COPY web ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4321/api/health || exit 1
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server/main.ts"]
