FROM oven/bun:1-debian AS build

USER root
WORKDIR /app

COPY package.json package-lock.json ./

# First run lets Bun migrate package-lock.json into bun.lock inside the image
RUN bun install

COPY tsconfig.json ./
COPY src ./src
COPY protos ./protos

RUN bunx tsc

# Reinstall production-only deps using the generated bun.lock
RUN rm -rf node_modules \
  && bun install --production --frozen-lockfile


FROM oven/bun:1-debian AS runtime

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
    docker.io \
    docker-compose \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

ARG AGAPORNIS_VERSION=0.1.0
ENV AGAPORNIS_API_VERSION=$AGAPORNIS_VERSION

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/protos ./protos
COPY package.json ./package.json

EXPOSE 3000 50051

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD bun -e "fetch('http://127.0.0.1:3000/api/system/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "dist/main.js"]