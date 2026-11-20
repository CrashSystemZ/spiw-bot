#!/bin/sh
# Firewall inside the shared network namespace of the bot + cobalt.
# They run with cap_drop ALL (no NET_ADMIN), so they cannot change these rules.
# Any failure here exits non-zero -> healthcheck fails -> bot/cobalt never start (fail closed).
set -eu

iptables -F INPUT; iptables -F OUTPUT
iptables -P INPUT DROP
iptables -P FORWARD DROP

# in: nothing except loopback (bot <-> cobalt, docker DNS) and replies
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# out: public internet only. Blocked = host, tailscale, other containers, LAN, cloud metadata.
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
           172.16.0.0/12 192.168.0.0/16 198.18.0.0/15 224.0.0.0/3 ${BLOCK_EXTRA:-}; do
    iptables -A OUTPUT -d "$net" -j REJECT
done

# no IPv6 at all
ip6tables -F INPUT; ip6tables -F OUTPUT
ip6tables -P INPUT DROP; ip6tables -P OUTPUT DROP; ip6tables -P FORWARD DROP
ip6tables -A INPUT -i lo -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT

echo "fw: rules applied"
touch /run/fw.ready
exec sleep infinity
