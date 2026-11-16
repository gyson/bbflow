.PHONY: build release release-assets test check skill-check web-build web-check

VERSION ?= dev

build: web-build
	CGO_ENABLED=0 go build -trimpath -o bin/bbflow ./cmd/bbflow

release: web-build
	CGO_ENABLED=0 go build -trimpath -ldflags '-X main.instanceDirName=.bbflow -X main.version=$(VERSION)' -o bin/release/bbflow ./cmd/bbflow

release-assets: web-build
	sh scripts/package-release.sh '$(VERSION)'

test: web-build
	CGO_ENABLED=0 go test ./...

check: web-build
	go vet ./...
	for script in internal/install/install.sh scripts/package-release.sh scripts/smoke-release.sh .agents/skills/review-loop/scripts/wait-for-pr.sh .agents/skills/review-loop/scripts/wait-for-pr.test.sh; do sh -n "$$script" || exit 1; done

skill-check:
	sh .agents/skills/review-loop/scripts/wait-for-pr.test.sh

web-build:
	npm --prefix web run build

web-check:
	npm --prefix web test
