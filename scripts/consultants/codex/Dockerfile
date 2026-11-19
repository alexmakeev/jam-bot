FROM node:22-bookworm-slim AS build
ARG CODEX_VERSION=0.169.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && cp "$(find /usr/local/lib/node_modules/@openai/codex -type f -path '*/bin/codex' | head -1)" /tmp/codex-cli \
    && cp "$(find /usr/local/lib/node_modules/@openai/codex -type f -name codex-code-mode-host | head -1)" /tmp/codex-code-mode-host \
    && mkdir -p /tmp/consultant-home/.codex /tmp/consultant-task \
    && chmod 700 /tmp/consultant-home/.codex

FROM scratch
COPY --from=build /tmp/codex-cli /bin/codex
COPY --from=build /tmp/codex-code-mode-host /usr/bin/codex-code-mode-host
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chown=1000:1000 /tmp/consultant-home /home/jam
COPY --from=build --chown=1000:1000 /tmp/consultant-task /task
ENV HOME=/home/jam SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
USER 1000:1000
WORKDIR /task
ENTRYPOINT ["/bin/codex"]
