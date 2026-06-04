# Code Meeseeks (内部代号 meebox) — 工程维护
#
# clean      : 删构建产物（out / dist / release / .nx cache / coverage / *.tsbuildinfo），
#              保留 node_modules + 嵌入式运行时 vendor（重装/重下成本高）
# clean-all  : clean + 删 node_modules + 嵌入式运行时 vendor（彻底重置；之后需
#              `npm install` 与 `npm --prefix apps/desktop run prepare:pragent`）
#
# 注：命令用 rm/find，Windows 下经 git bash 执行（make 不可用时可直接照搬命令）。

.PHONY: clean clean-all

clean:
	rm -rf .nx/cache
	rm -rf apps/desktop/out apps/desktop/release apps/desktop/dist
	rm -rf packages/*/dist
	rm -rf coverage
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
	@echo "cleaned build artifacts (node_modules + vendor 保留)"

clean-all: clean
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
	rm -rf apps/desktop/vendor
	@echo "removed node_modules + 嵌入式运行时 vendor；需重新 npm install + prepare:pragent"
