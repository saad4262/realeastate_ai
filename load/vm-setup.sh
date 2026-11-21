#!/usr/bin/env bash
# PLATFORM-PLAN 4.3: a fresh Ubuntu VM in Sydney (AWS ap-southeast-2), ready to run load/run.sh against a Vercel preview.
# On the VM, once:  curl -fsSL https://raw.githubusercontent.com/saad4262/realeastate_ai/test/4.3-load-judged/load/vm-setup.sh | bash
# Then copy .env.dev in by hand (scp, never committed) and log in again so the open-files limit applies.
set -euo pipefail
BRANCH="${BRANCH:-test/4.3-load-judged}"

sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates gnupg postgresql-client

# k6 from Grafana's apt repository (k6 docs, "Install k6", Debian/Ubuntu).
curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor --yes -o /usr/share/keyrings/k6-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
# Node 22 (.nvmrc); pnpm comes from the repo's packageManager through corepack.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y k6 nodejs
sudo corepack enable

# k6 opens a socket per request in flight (k6 docs, "Fine-tuning OS").
printf '* soft nofile 250000\n* hard nofile 250000\n' | sudo tee /etc/security/limits.d/k6.conf
printf 'net.ipv4.ip_local_port_range=1024 65535\nnet.ipv4.tcp_tw_reuse=1\nnet.core.somaxconn=65535\n' | sudo tee /etc/sysctl.d/90-k6.conf
sudo sysctl --system >/dev/null

[[ -d realestate_ai ]] || git clone --branch "$BRANCH" https://github.com/saad4262/realeastate_ai.git realestate_ai
cd realestate_ai && corepack pnpm install --frozen-lockfile
echo "Ready. Next: copy .env.dev to ~/realestate_ai/.env.dev, log in again, then follow load/README.md 'A free machine in Sydney'."
