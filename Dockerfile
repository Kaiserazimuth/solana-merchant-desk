FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./server.mjs
COPY preview.mjs ./preview.mjs
COPY preview.mjs ./preview.mjs
COPY src ./src
COPY public ./public
EXPOSE 3000
CMD ["npm", "start"]
