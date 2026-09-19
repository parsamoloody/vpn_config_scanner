FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ curl unzip

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

# Install runtime dependencies: curl, unzip (for xray download if needed)
RUN apk add --no-cache curl unzip

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Create persistent data and bin directories
RUN mkdir -p /app/data /app/bin

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/vpn_monitor.sqlite

VOLUME ["/app/data"]

CMD ["node", "dist/index.js"]
