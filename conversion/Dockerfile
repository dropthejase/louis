FROM --platform=linux/amd64 public.ecr.aws/lambda/nodejs:20

# Install LibreOffice — Amazon Linux 2023 uses dnf
RUN dnf install -y libreoffice --setopt=install_weak_deps=False && \
    dnf clean all && \
    rm -rf /var/cache/dnf

WORKDIR ${LAMBDA_TASK_ROOT}

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./

CMD ["index.handler"]
