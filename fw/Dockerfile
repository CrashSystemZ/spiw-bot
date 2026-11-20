FROM alpine:3
RUN apk add --no-cache iptables && iptables -V && ip6tables -V
COPY fw.sh /fw.sh
ENTRYPOINT ["/bin/sh", "/fw.sh"]
