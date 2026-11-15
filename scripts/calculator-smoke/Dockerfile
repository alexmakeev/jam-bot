FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /smoke
RUN npm install --no-audit --no-fund --ignore-scripts playwright-core@1.56.1 typescript@5.9.3
COPY smoke.mjs dragon-acceptance.mjs ./
USER pwuser
ENTRYPOINT ["node", "/smoke/smoke.mjs"]
