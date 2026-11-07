# Leash: zero runtime dependencies, so the image is Node itself plus the source.
FROM node:26-alpine
RUN apk upgrade --no-cache
ENV NODE_ENV=production LEASH_DATA_DIR=/data PORT=8080
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
