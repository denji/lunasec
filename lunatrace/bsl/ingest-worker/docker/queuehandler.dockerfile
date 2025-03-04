FROM golang:1.18-alpine AS builder

COPY --from=repo-bootstrap /usr/repo/ /build/
WORKDIR /build/lunatrace/bsl/ingest-worker

RUN CGO_ENABLED=0 GOOS=linux go build -o queuehandler ./cmd/queuehandler

FROM alpine

RUN apk add --update python3 python3-dev py3-pip gcc musl-dev

RUN pip install semgrep

COPY --from=builder /build/lunatrace/bsl/ingest-worker/queuehandler /

ENTRYPOINT ["/queuehandler"]
