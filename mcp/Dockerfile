FROM node:22-alpine

WORKDIR /srv

COPY package.json package-lock.json* ./
RUN npm install

COPY src ./src
COPY test ./test

# stdio MCP server: attach with `docker run --rm -i agent-passport-mcp`
CMD ["node", "src/index.mjs"]