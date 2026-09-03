#!/bin/bash
# Install the GitHub Actions self-hosted runner as a systemd service on the Pi.
# Run as the deploy user (not root), after scp:   ssh -t researchpi 'RUNNER_TOKEN=<token> ./install-runner.sh'
# Needs a registration token: gh api -X POST repos/ezragubbay/quire/actions/runners/registration-token -q .token
set -euo pipefail
: "${RUNNER_TOKEN:?export RUNNER_TOKEN=<registration token> first}"
REPO_URL=${REPO_URL:-https://github.com/ezragubbay/quire}
cd /srv/quire/runner
if [[ ! -f run.sh ]]; then
  ver=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
  curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${ver}/actions-runner-linux-arm64-${ver}.tar.gz"
  tar xzf runner.tar.gz && rm runner.tar.gz
fi
./config.sh --unattended --url "$REPO_URL" --token "$RUNNER_TOKEN" --name researchpi --labels self-hosted,linux,arm64,researchpi --work _work --replace
sudo ./svc.sh install "$(whoami)"
sudo ./svc.sh start
echo "runner installed and started"
