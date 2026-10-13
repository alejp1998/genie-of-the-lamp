# Genie Agent Gateway. Node 24 runs the TypeScript sources directly (type
# stripping), so there is no build stage.
FROM node:24-bookworm-slim
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src src
ENV NODE_ENV=production \
    AGENT_GATEWAY_HOST=0.0.0.0 \
    AGENT_GATEWAY_PORT=3300 \
    AGENT_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3300
LABEL org.opencontainers.image.source="https://github.com/alejp1998/genie-of-the-lamp" \
      org.opencontainers.image.description="Genie Agent Gateway: research-writing assistant for Aldine" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.ts"]
