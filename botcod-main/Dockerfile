FROM node:24-bookworm-slim
ENV NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_CACHE_DIR=/opt/puppeteer BOT_DATA_DIR=/data
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-liberation tini libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxkbcommon0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json .puppeteerrc.cjs ./
RUN npm ci --omit=dev
RUN node node_modules/puppeteer/lib/cjs/puppeteer/node/cli.js browsers install chrome@146.0.7680.31
COPY app.js ./
COPY lib ./lib
COPY public ./public
COPY assets ./assets
COPY data ./data
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "app.js"]
