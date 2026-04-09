FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV REDIS_URL=redis://redis-stack:6379
ENV PORT=3000
ENV PGHOST=postgres
ENV PGPORT=5432
ENV PGDATABASE=afc
ENV PGUSER=postgres
ENV PGPASSWORD=admin

EXPOSE 3000

CMD ["npm", "start"]