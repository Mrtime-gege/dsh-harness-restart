#!/usr/bin/env bash
# test-in-profile.sh —— 隔离环境真实安装验收（CI 与本地均可用，不触碰运行中的实例）。
#
# 流程：
#   1. 独立 DSH_HOME（mktemp）
#   2. dsh --profile rescue --from-default-profile web（最小 web 模板）
#   3. 把本插件以 file: 方式落进 rescue 的 node_modules + patch 一行
#   4. 运行单元测试（DSH_RESTART_MODULE 指向副本）
#   5. 在临时端口启动实例 → 探测插件 /status 路由 → 关闭
#
# 前置：PATH 里能找到 dsh@0.1.5-rc.1（CI 已 `npm i -g @deepseek-ai/dsh@0.1.5-rc.1`）。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${DSH_HARNESS_TEST_PORT:-3199}"
HOME_T="$(mktemp -d -t dshr-test-XXXX)"
PID=""

cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  rm -rf "$HOME_T"
}
trap cleanup EXIT

command -v dsh >/dev/null 2>&1 || { echo "ERR: dsh 不在 PATH（CI 用 npm i -g @deepseek-ai/dsh@0.1.5-rc.1）"; exit 2; }

echo "== 1/5 准备隔离 DSH_HOME（$HOME_T）"
export DSH_HOME="$HOME_T"
# 注意：--from-default-profile web 会先建 profile 目录、随即尝试在默认 3080 启动；
# 若 3080 被占用会以 EADDRINUSE 失败退出——这是预期的，profile 文件已生成。
set +e
env -u INVOCATION_ID -u JOURNAL_STREAM -u SYSTEMD_EXEC_PID dsh --profile rescue --from-default-profile web >/dev/null 2>&1
set -e
RP="$HOME_T/profiles/rescue"
[ -f "$RP/package.json" ] || { echo "ERR: rescue profile 创建失败"; exit 1; }
echo "== rescue profile 就绪（$RP）"

echo "== 2/5 安装本插件（file: 方式，仅 lib/patch/package.json）"
mkdir -p "$RP/node_modules/dsh-harness-restart"
cp -r "$ROOT/lib" "$ROOT/cordis.patch.yml" "$ROOT/package.json" "$RP/node_modules/dsh-harness-restart/"
cat > "$HOME_T/patch.yml" <<EOF
- insert:
    - id: harness-restart
      name: 'dsh-harness-restart'
      config:
        restartDelayMs: 1500
EOF

echo "== 3/5 单元测试"
DSH_RESTART_MODULE="$RP/node_modules/dsh-harness-restart/lib/index.js" \
  node "$ROOT/tests/unit.mjs"

echo "== 4/5 启动隔离实例（端口 $PORT）并探测 /status"
env -u INVOCATION_ID -u JOURNAL_STREAM -u SYSTEMD_EXEC_PID \
  dsh --profile rescue --patch "$HOME_T/patch.yml" --port "$PORT" --no-open >"$HOME_T/boot.log" 2>&1 &
PID=$!

UP=0
for _ in $(seq 1 40); do
  sleep 1
  if curl -sS --max-time 2 "http://127.0.0.1:$PORT/plugins/dsh-harness-restart/status" 2>/dev/null | grep -q '"pid"'; then
    UP=1
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then echo "ERR: 实例提前退出："; tail -15 "$HOME_T/boot.log"; exit 1; fi
done
[ "$UP" = "1" ] || { echo "ERR: 40s 内未就绪"; exit 1; }

echo "== 5/5 冒烟通过"
curl -sS "http://127.0.0.1:$PORT/plugins/dsh-harness-restart/status" | head -c 200; echo
curl -sS "http://127.0.0.1:$PORT/plugins/dsh-harness-restart/config" | head -c 160; echo

kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""
echo "ALL GREEN — isolated profile install + boot verified"