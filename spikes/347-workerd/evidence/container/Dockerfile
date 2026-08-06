# Minimal computerd container for the workerd localDocker probe.
# computerd binary comes from the public GHCR scratch image (x64 only;
# no arm64 variant exists as of 0.1.0-alpha.1 — runs under Rosetta on
# Apple Silicon Docker Desktop).
FROM --platform=linux/amd64 ghcr.io/cloudflare/computer-computerd-linux-x64:0.1.0-alpha.1 AS computerd

FROM --platform=linux/amd64 debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
