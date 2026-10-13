# Single always-on instance (Railway, Render or Fly.io). Socket Mode needs no public URL.
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production TZ=America/Chicago
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY config ./config
COPY data/reference-sample.json ./data/
CMD ["node", "dist/src/index.js"]
