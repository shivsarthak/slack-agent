# syntax=docker/dockerfile:1.7
FROM node:22.22.0-alpine AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM dependencies AS runtime
COPY src ./src
COPY drizzle ./drizzle
USER node

FROM dependencies AS build-dependencies
RUN pnpm install --frozen-lockfile

FROM build-dependencies AS dashboard-build
COPY dashboard/package.json dashboard/pnpm-lock.yaml ./dashboard/
RUN pnpm --dir dashboard install --frozen-lockfile
COPY src ./src
COPY dashboard ./dashboard
RUN pnpm --dir dashboard build

FROM dependencies AS dashboard
COPY --from=dashboard-build /app/dashboard ./dashboard
USER node
