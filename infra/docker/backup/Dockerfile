FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

# postgresql16-client must be >= the server major (postgis/postgis:16-3.4).
RUN apk add --no-cache \
  postgresql16-client \
  age \
  rclone \
  bash \
  curl \
  coreutils \
  util-linux

COPY backup.sh /usr/local/bin/backup.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY crontab /etc/crontabs/root

RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["crond", "-f", "-l", "2"]
