FROM node:22-bookworm-slim AS node
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && npm install --global @anthropic-ai/claude-code@2.1.325 && useradd --create-home --uid 1000 jam
WORKDIR /opt/jam-bot
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src src
COPY test test
RUN npm run build
RUN install -d -o jam -g jam /var/lib/jam
USER jam
ENV HOME=/home/jam
CMD ["claude"]
