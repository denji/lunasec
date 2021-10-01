FROM node:14 as lerna-bootstrap

RUN apt-get update && apt-get install --yes openjdk-8-jre curl sqlite

RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
RUN unzip awscliv2.zip
RUN ./aws/install

RUN aws --version

ENV NODE_OPTIONS "--unhandled-rejections=strict"
RUN yarn global add lerna

COPY . /repo

WORKDIR /repo

RUN lerna bootstrap --ignore-scripts --ci
RUN npm rebuild --workspaces

RUN yarn run compile:dev:sdks

FROM lerna-bootstrap as demo-back-end

WORKDIR /repo/js/demo-apps/packages/demo-back-end

ENTRYPOINT yarn start:dev

FROM lerna-bootstrap as react-front-end

WORKDIR /repo/js/demo-apps/packages/react-front-end

ENTRYPOINT yarn run start

FROM cypress/included:8.4.0 as integration-test

ENV VERBOSE_CYPRESS_LOGS="always"

COPY --from=lerna-bootstrap /repo /repo

WORKDIR /repo/js/demo-apps/packages/react-front-end

ENTRYPOINT npm run test:e2e

FROM lerna-bootstrap as secure-frame-iframe

WORKDIR /repo/js/sdks/packages/secure-frame-iframe

RUN yarn run compile

RUN npm i -g http-server

ENTRYPOINT http-server -a 0.0.0.0 -p 8000
