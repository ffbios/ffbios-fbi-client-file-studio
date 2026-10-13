FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY index.js /app/index.js
COPY logo.png /app/logo.png
ENV NODE_ENV=production
CMD ["node", "/app/index.js"]
