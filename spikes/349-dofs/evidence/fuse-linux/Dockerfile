FROM --platform=linux/amd64 node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      fuse libfuse2 procps curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/deno.zip https://dl.deno.land/release/v2.9.1/deno-x86_64-unknown-linux-gnu.zip \
    && unzip /tmp/deno.zip -d /usr/local/bin \
    && rm /tmp/deno.zip \
    && chmod +x /usr/local/bin/deno
RUN mkdir -p /mnt/ws
CMD ["sleep", "infinity"]
