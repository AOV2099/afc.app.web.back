FROM node:20-alpine

WORKDIR /app

# Instala dependencias primero para aprovechar cache de capas
COPY package*.json ./
RUN npm ci --omit=dev

# Copia el resto del proyecto
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
