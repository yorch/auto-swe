# Default executor image for Go projects
FROM golang:1.26-bookworm@sha256:386f0cbb8fb3402ff5a15048c96731e6ff37142d31182f3b72306359a1f5e9b7

# git and bash ship in the golang image; tar for copy in/out and ripgrep so Pi's
# grep honours .gitignore are added.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep tar bash \
    && rm -rf /var/lib/apt/lists/*

# The base image's GOPATH (/go) is root-owned, so the module and build caches
# live under the executor's home, where `go test` and `go build` can write.
ENV GOPATH=/home/executor/go \
    GOCACHE=/home/executor/.cache/go-build \
    PATH=/home/executor/go/bin:/usr/local/go/bin:$PATH

WORKDIR /workspace/target-repo

# Hand ownership of the workspace tree to a non-root user (uid 1000) so the
# executor can write files at runtime (clone, build output, module cache)
# without EACCES.
RUN useradd --create-home --uid 1000 executor \
    && mkdir -p /workspace /home/executor/go /home/executor/.cache \
    && chown -R executor:executor /workspace /home/executor

USER executor
