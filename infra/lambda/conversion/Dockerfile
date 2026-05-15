FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:22 AS builder

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM --platform=linux/amd64 public.ecr.aws/shelf/lambda-libreoffice-base:26.2-node22-x86_64

WORKDIR ${LAMBDA_TASK_ROOT}

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /build/dist/ ./

CMD ["index.handler"]
