# Engine runtime image — multi-stage, non-root, secrets at runtime only.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY products_manifests ./products_manifests
COPY drizzle ./drizzle
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S neryva && adduser -S neryva -G neryva
COPY --from=build --chown=neryva:neryva /app/node_modules ./node_modules
COPY --from=build --chown=neryva:neryva /app/dist ./dist
COPY --from=build --chown=neryva:neryva /app/package.json ./
# Manifests + migrations ship with the image so boot and migrate need no build context.
COPY --from=build --chown=neryva:neryva /app/products_manifests ./products_manifests
COPY --from=build --chown=neryva:neryva /app/drizzle ./drizzle
USER neryva
EXPOSE 3001
CMD ["node", "dist/main.js"]
