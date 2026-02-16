# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev --workspace @hexonis/server --workspace @hexonis/shared

FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/server/src apps/server/src
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src

EXPOSE 3001

CMD ["npm", "run", "start", "--workspace", "@hexonis/server"]
