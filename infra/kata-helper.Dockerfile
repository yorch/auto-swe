FROM alpine:3.20
RUN apk add --no-cache iptables ip6tables iproute2 iproute2-tc nftables conntrack-tools git bash busybox-extras
CMD ["sleep", "infinity"]
