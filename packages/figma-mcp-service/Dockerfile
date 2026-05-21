FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS base
WORKDIR /app
ENV NODE_ENV=production
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9 --activate

# ---- deps ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/figma-mcp-service/package.json packages/figma-mcp-service/
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---- build ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/figma-mcp-service packages/figma-mcp-service
RUN pnpm --filter @figma-mcp-poc/shared build
RUN pnpm --filter figma-mcp-service build

# ---- runtime ----
FROM base AS runtime
COPY --from=build /app /app
WORKDIR /app
EXPOSE 3000
ENV PORT=3000

# FIGMA_STATE_JSON (base64 of .playwright-state/figma.json) must be provided via
# `fly secrets set FIGMA_STATE_JSON=$(base64 < .playwright-state/figma.json)`.
CMD ["node", "packages/figma-mcp-service/dist/server.js"]
