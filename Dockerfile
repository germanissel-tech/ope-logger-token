# pegar contenido, Ctrl+O, Enter, Ctrl+XFROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]


