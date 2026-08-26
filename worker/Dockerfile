# JustSports news aggregator — no dependencies, just Node.
FROM node:22-alpine
WORKDIR /app
COPY package.json feeds.js server.js ./
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
