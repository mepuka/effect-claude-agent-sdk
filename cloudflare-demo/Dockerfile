FROM docker.io/cloudflare/sandbox:0.7.0

# Install Claude Code CLI (npm package)
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user (claude CLI refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash claude
USER claude
WORKDIR /home/claude
