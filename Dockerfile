FROM node:20-slim

WORKDIR /app

# git is REQUIRED: Baileys depends on libsignal via a github: URL, so
# npm must spawn git to fetch it — without git the install dies with
# "npm error syscall spawn git / ENOENT" (Coolify build 23 Oct 2026).
# python3/make/g++ cover any native helpers that compile on install.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
