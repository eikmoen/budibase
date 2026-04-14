FROM node:22-alpine AS build

RUN apk add --no-cache \
    g++ \
    make \
    python3 \
    git \
    bash \
    jq \
    curl

WORKDIR /app
COPY package.json yarn.lock lerna.json .yarnrc tsconfig.build.json nx.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY hosting ./hosting

RUN yarn install --frozen-lockfile
RUN DISABLE_V8_COMPILE_CACHE=1 NODE_OPTIONS=--max-old-space-size=4096 yarn build

FROM node:22-alpine

WORKDIR /app

ENV PORT=4002
ENV BUDIBASE_ENVIRONMENT=PRODUCTION
ENV SERVICE=app-service
ENV ACCOUNT_PORTAL_URL=https://account.budibase.app
ENV TOP_LEVEL_PATH=/app

RUN apk add --no-cache \
    g++ \
    make \
    python3 \
    jq \
    bash \
    postgresql-client \
    git \
    procps \
    iproute2 \
    curl \
    bind-tools \
    netcat-openbsd \
    openssl \
    lsof \
    strace \
    less \
    coreutils \
    tzdata

RUN yarn global add pm2

COPY scripts/removeWorkspaceDependencies.sh scripts/removeWorkspaceDependencies.sh
RUN chmod +x ./scripts/removeWorkspaceDependencies.sh

COPY --from=build /app/packages/server/package.json ./package.json
COPY --from=build /app/packages/server/dist/yarn.lock ./dist/yarn.lock
RUN ./scripts/removeWorkspaceDependencies.sh package.json

ARG TARGETPLATFORM
RUN --mount=type=cache,target=/root/.yarn/${TARGETPLATFORM} YARN_CACHE_FOLDER=/root/.yarn/${TARGETPLATFORM} yarn install --production \
    && yarn cache clean \
    && apk del g++ make python3 \
    && rm -rf /tmp/* /root/.node-gyp /usr/local/lib/node_modules/npm/node_modules/node-gyp

COPY --from=build /app/packages/server/dist/ ./dist/
COPY --from=build /app/packages/server/docker_run.sh ./docker_run.sh
COPY --from=build /app/packages/server/builder/ ./builder/
COPY --from=build /app/packages/server/client/ ./client/
COPY --from=build /app/packages/server/pm2.config.js ./pm2.config.js

ARG BUDIBASE_VERSION=0.0.0+fork-coolify
ARG GIT_COMMIT_SHA=unknown
RUN jq --arg v "$BUDIBASE_VERSION" '.version = $v' package.json > tmp.json && mv tmp.json package.json
ENV BUDIBASE_VERSION=$BUDIBASE_VERSION
ENV DD_GIT_REPOSITORY_URL=https://github.com/Budibase/budibase
ENV DD_GIT_COMMIT_SHA=$GIT_COMMIT_SHA
ENV DD_VERSION=$BUDIBASE_VERSION

EXPOSE 4002

ENV NODE_ENV=production
ENV NODE_OPTIONS="--no-node-snapshot"

CMD ["./docker_run.sh"]
