# syntax=docker/dockerfile:1
ARG RESTIC_BASE_IMAGE=ghcr.io/by275/restic:latest
FROM ${RESTIC_BASE_IMAGE}

ARG RESTIC_RUNTIME_USER=0
USER 0

RUN apk add --no-cache bash coreutils curl jq \
    && mkdir -p /usr/local/libexec \
    && mkdir -p /var/lib/restic-monitor \
    && chown "$RESTIC_RUNTIME_USER" /var/lib/restic-monitor \
    && mv /usr/local/bin/restic /usr/local/libexec/restic.real

COPY bin/restic-monitor /usr/local/bin/restic-monitor
COPY integrations/docker-restic/restic-shim /usr/local/bin/restic

RUN chmod 0755 /usr/local/bin/restic-monitor /usr/local/bin/restic

USER ${RESTIC_RUNTIME_USER}

ENV RESTIC_MONITOR_RESTIC_BIN=/usr/local/libexec/restic.real \
    RESTIC_MONITOR_SPOOL_DIR=/var/lib/restic-monitor
