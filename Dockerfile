FROM node:20-slim

# Instalar Python3 + pip
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instalar dependencias Node
COPY api/package*.json ./api/
RUN cd api && npm ci --only=production

# Instalar dependencias Python
COPY etl/requirements.txt ./etl/
RUN pip3 install -r etl/requirements.txt --break-system-packages

# Copiar código fuente
COPY api/ ./api/
COPY etl/ ./etl/

ENV PYTHON_BIN=python3
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "api/src/app.js"]
