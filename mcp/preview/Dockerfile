FROM node:22-slim
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY shared ./shared
COPY mcp/viewer ./mcp/viewer
COPY mcp/preview ./mcp/preview
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "mcp/preview/health.js"]
CMD ["node", "mcp/preview/server.js"]
