FROM node:22-alpine

WORKDIR /srv

COPY package.json package-lock.json* ./
RUN npm install

COPY src ./src

EXPOSE 8787
CMD ["node", "src/server.mjs"]