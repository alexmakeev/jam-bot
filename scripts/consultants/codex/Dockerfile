FROM node:22-bookworm-slim AS build
ARG CODEX_VERSION=0.169.0
RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && cp "$(find /usr/local/lib/node_modules/@openai/codex -type f -path '*/bin/codex' | head -1)" /tmp/codex-cli \
    && mkdir -p /tmp/consultant-home/.codex /tmp/consultant-task \
    && chmod 700 /tmp/consultant-home/.codex

FROM scratch
COPY --from=build /tmp/codex-cli /bin/codex
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build --chown=1000:1000 /tmp/consultant-home /home/jam
COPY --from=build --chown=1000:1000 /tmp/consultant-task /task
ENV HOME=/home/jam SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
USER 1000:1000
WORKDIR /task
ENTRYPOINT ["/bin/codex"]
