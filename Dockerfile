FROM node:18-slim

WORKDIR /app

# Copy package files and install deps
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

# HuggingFace requires port 7860
ENV PORT=7860
EXPOSE 7860

# Start the bot
CMD ["node", "src/bot.js"]
