# The binary is cross-compiled on the build machine, not in Docker:
#   cargo zigbuild --release --target x86_64-unknown-linux-musl
# The image holds that one static binary and the CA bundle. No shell, no libc, no package manager.
FROM alpine:3 AS certs
RUN apk add --no-cache ca-certificates

FROM scratch
COPY --from=certs /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY target/x86_64-unknown-linux-musl/release/spiw-bot /spiw-bot
USER 10001:10001
ENTRYPOINT ["/spiw-bot"]
