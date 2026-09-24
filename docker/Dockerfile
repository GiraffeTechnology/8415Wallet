# Development image. The project runs TypeScript from source, so there is no
# build step: the image only needs Node and the dev dependencies.
FROM node:22-slim

WORKDIR /srv/8415wallet

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .

CMD ["npm", "run", "verify"]
