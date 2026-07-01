# evmsec — a security CLI for EVM chains.
# Multi-stage: build the TS, then ship only prod deps + dist on a slim runtime.
#
#   docker build -t evmsec .
#   docker run --rm -e ETHEREUM_RPC_URL=https://your-rpc evmsec audit 0xContract --chain ethereum
#   docker run --rm evmsec solvency --all
#
# The MCP server is the same image:
#   docker run --rm -i evmsec-mcp        # (entrypoint override below)

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY bridges.json deps.example.json ./
# Run as the built-in non-root user.
USER node
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]
