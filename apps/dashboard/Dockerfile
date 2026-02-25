FROM node:20-slim AS base

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @mesa/dashboard... build

EXPOSE 3000
CMD ["pnpm", "--filter", "@mesa/dashboard", "start"]
