#!/usr/bin/env bash
# 发版：把 dev 分支的**发布物文件**同步成 release 分支、压缩成一个提交、打 tag。
# （发布模型参考 dsh-agent-shell：公开仓库只看到版本级提交，私有备份仓收全部小提交。）
#
# 双分支模型（本仓库）：
#   * `dev`     —— 开发分支（全量：插件 + tests + scripts + docs + CI）。每完成一部分就提交一次。
#   * `release` —— 公开分支（**只含插件本体**）：package.json / lib/* / cordis.patch.yml / README.md / LICENSE / .gitignore
#   公开远端（origin）只推 `release`；`dev` 的小提交只进私有备份远端（scripts/backup-push.sh）。
#
# 用法：
#   bash scripts/release-prepare.sh 0.1.0            # 预演：打印会做什么，不改动任何东西
#   bash scripts/release-prepare.sh 0.1.0 --push     # 真执行（推公开远端 release 分支 + 推 tag = 发布）
#
# ⚠️ `--push` 等于**发布**。按铁律，只有维护者本人可以下这个决定 —— AI 助手不得代跑。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

VERSION="${1:-}"
PUSH="${2:-}"
PUBLIC_REMOTE="${PUBLIC_REMOTE:-origin}"
PUBLIC_BRANCH="${PUBLIC_BRANCH:-release}"
DEV_BRANCH="${DEV_BRANCH:-dev}"

# release 分支上的发布物文件（与 package.json files 白名单一致 + 仓库卫生文件）
RELEASE_PATHS=(
  package.json
  lib
  cordis.patch.yml
  README.md
  SECURITY.md
  NOTICE
  LICENSE
  .github/workflows
  scripts/release-check.mjs
  scripts/lib
  .gitignore
)

[ -n "$VERSION" ] || { echo "用法: bash scripts/release-prepare.sh <版本号> [--push]"; exit 2; }
[ "$PUSH" = "" ] || [ "$PUSH" = "--push" ] || { echo "✗ 第二个参数只接受 --push"; exit 2; }

step() { printf '\n── %s\n' "$*"; }

step "0. 前置检查"
[ -z "$(git status --porcelain)" ] || { echo "✗ 工作树不干净，先提交或清理"; exit 1; }
echo "  ✓ 工作树干净"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$CURRENT_BRANCH" = "$DEV_BRANCH" ] || { echo "✗ 请在 ${DEV_BRANCH} 分支上发版（当前 ${CURRENT_BRANCH}）"; exit 1; }

current="$(node -p "require('./package.json').version")"
[ "$current" = "$VERSION" ] || { echo "✗ package.json 版本是 ${current}，与要发布的 ${VERSION} 不一致"; exit 1; }
echo "  ✓ package.json 版本 = ${VERSION}"

git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null && { echo "✗ tag v${VERSION} 已存在（发布过的版本不能重发）"; exit 1; }
echo "  ✓ tag v${VERSION} 尚未存在"

echo "  · 跑发布不变量检查…"
npm run --silent release:check || exit 1

step "1. 预演/执行"
if [ "$PUSH" != "--push" ]; then
  echo "  （预演模式：不改动任何东西）将执行："
  echo "    · 切到 ${PUBLIC_BRANCH}，把 ${DEV_BRANCH} 的发布物文件同步过来（package.json / lib / cordis.patch.yml / README.md / LICENSE / .gitignore）"
  echo "    · 若与现有 ${PUBLIC_BRANCH} 有差异，压缩成一个提交：release: v${VERSION}"
  echo "    · 打 tag v${VERSION}"
  echo "    · git push ${PUBLIC_REMOTE} ${PUBLIC_BRANCH} && git push ${PUBLIC_REMOTE} --tags   ← 推 tag = 触发 npm 自动发布"
  echo "    · 随后备份私有仓：bash scripts/backup-push.sh"
  echo
  echo "  确认无误后执行：bash scripts/release-prepare.sh ${VERSION} --push"
  exit 0
fi

git rev-parse -q --verify "refs/heads/${PUBLIC_BRANCH}" >/dev/null || git branch "$PUBLIC_BRANCH"
git checkout -q "$PUBLIC_BRANCH"
git checkout -q "$DEV_BRANCH" -- "${RELEASE_PATHS[@]}"
git add -A
if git diff --cached --quiet; then
  echo "  · 发布物无变化（仅文档/脚本变动），跳过压缩提交"
else
  git commit -q -m "release: v${VERSION}"
  echo "  ✓ 已生成版本级提交（压缩）"
fi

step "2. 打 tag v${VERSION}"
git tag -a "v${VERSION}" -m "v${VERSION}"
echo "  ✓ tag 已创建"

step "3. 推送公开远端"
git push "$PUBLIC_REMOTE" "$PUBLIC_BRANCH"
git push "$PUBLIC_REMOTE" --tags
echo "  ✓ 已推送（发布工作流将开始）"
echo "  · 建议紧接着备份私有仓：bash scripts/backup-push.sh"

git checkout -q "$DEV_BRANCH"
echo
echo "✓ 完成（当前分支：$(git rev-parse --abbrev-ref HEAD)）"