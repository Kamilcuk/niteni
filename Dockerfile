FROM node:20-slim

WORKDIR /app

# Install git for diffing
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy source code and build
COPY . .
RUN npm run build

# Link the binary
RUN npm link
RUN niteni --help

ENTRYPOINT ["niteni"]
