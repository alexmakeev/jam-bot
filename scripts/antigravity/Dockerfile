FROM ubuntu:22.04 AS installer
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/install.sh && bash /tmp/install.sh && /root/.local/bin/agy --version

FROM ubuntu:22.04
COPY --from=installer /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=installer /root/.local/bin/agy /usr/local/bin/agy
RUN groupadd -g 1000 jam && useradd -m -u 1000 -g 1000 jam && install -d -o jam -g jam /work
ENV HOME=/home/jam
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/agy"]
