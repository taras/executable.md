.PHONY: install run example lint typecheck test check

DOC ?= examples/hello-world.md
JOURNAL ?=

install:
	pnpm install

run:
	pnpm ema $(DOC) $(if $(JOURNAL),--journal $(JOURNAL),)

example:
	$(MAKE) run DOC=examples/hello-world.md

lint:
	pnpm lint

typecheck:
	pnpm typecheck

test:
	pnpm test

check:
	$(MAKE) lint
	$(MAKE) typecheck
	$(MAKE) test
