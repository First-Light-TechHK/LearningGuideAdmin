# Admin API: NestJS + Prisma. Client is built separately and served as static assets.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate
COPY . .
# The release builder supplies the exact source commit; provenance must bind this value to the image.
ARG BUILD_COMMIT
RUN BUILD_COMMIT="$BUILD_COMMIT" npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main"]
