FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /smoke
RUN npm install --no-audit --no-fund --ignore-scripts playwright-core@1.56.1 typescript@5.9.3 pngjs@7.0.0
COPY smoke.mjs dragon-acceptance.mjs sum-acceptance.mjs static-dragons.mjs ./
USER pwuser
ENTRYPOINT ["node", "/smoke/smoke.mjs"]
