FROM node:26-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a
WORKDIR /app
RUN mkdir /state && chown node:node /state && chmod 700 /state
COPY --chown=node:node packages/docker-broker/package.json ./package.json
COPY --chown=node:node packages/docker-broker/src ./src
USER node
ENV DOCKER_BROKER_STATE_DIR=/state
EXPOSE 2375
CMD ["node", "src/index.ts"]
