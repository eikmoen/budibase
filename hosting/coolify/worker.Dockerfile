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

RUN apk add --no-cache --virtual .gyp python3 make g++ \
    && apk add --no-cache \
        jq \
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

WORKDIR /
COPY scripts/removeWorkspaceDependencies.sh scripts/removeWorkspaceDependencies.sh
RUN chmod +x ./scripts/removeWorkspaceDependencies.sh

WORKDIR /app
COPY --from=build /app/packages/worker/package.json ./package.json
COPY --from=build /app/packages/worker/dist/yarn.lock ./dist/yarn.lock
RUN ../scripts/removeWorkspaceDependencies.sh package.json

ARG TARGETPLATFORM
RUN --mount=type=cache,target=/root/.yarn/${TARGETPLATFORM} YARN_CACHE_FOLDER=/root/.yarn/${TARGETPLATFORM} yarn install --production \
    && apk del .gyp \
    && yarn cache clean

COPY --from=build /app/packages/worker/dist/ ./dist/
COPY --from=build /app/packages/worker/docker_run.sh ./docker_run.sh
COPY --from=build /app/packages/server/pm2.config.js ./pm2.config.js

EXPOSE 4003

ENV NODE_ENV=production
ENV NODE_OPTIONS="--no-node-snapshot"
ENV CLUSTER_MODE=${CLUSTER_MODE}
ENV SERVICE=worker-service
ENV ACCOUNT_PORTAL_URL=https://account.budibase.app

ARG BUDIBASE_VERSION=0.0.0+fork-coolify
ARG GIT_COMMIT_SHA=unknown
RUN jq --arg v "$BUDIBASE_VERSION" '.version = $v' package.json > tmp.json && mv tmp.json package.json
ENV BUDIBASE_VERSION=$BUDIBASE_VERSION
ENV DD_GIT_REPOSITORY_URL=https://github.com/Budibase/budibase
ENV DD_GIT_COMMIT_SHA=$GIT_COMMIT_SHA
ENV DD_VERSION=$BUDIBASE_VERSION

CMD ["./docker_run.sh"]
