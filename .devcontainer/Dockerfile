FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# The rolling base currently contains Node 22.16. The repository imports
# TypeScript in native tests and requires the tested 22.21 runtime or newer.
USER root
RUN . /usr/local/share/nvm/nvm.sh \
    && nvm install 22.21.0 \
    && nvm alias default 22.21.0 \
    && nvm cache clear
ENV PATH="/usr/local/share/nvm/versions/node/v22.21.0/bin:${PATH}"
USER node
