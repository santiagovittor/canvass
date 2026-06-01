FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm install
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json* ./
RUN npm install --workspace=server --omit=dev
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
