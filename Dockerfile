FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app

RUN addgroup --system --gid 1001 vanta && \
    adduser --system --uid 1001 vanta

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

USER vanta

ENV NODE_ENV=production
ENV VANTA_LOG_LEVEL=info

EXPOSE 8080

CMD ["node", "dist/index.js"]
