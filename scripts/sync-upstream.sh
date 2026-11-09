#!/usr/bin/env bash
# 把官方上游 songloft-plugin-miot 的主分支合入当前分支。
#
# 本仓库是以官方 main 为基线重建的 fork（与上游历史共享祖先），因此直接
# git merge 即可。早期“tarball 导入 + 快照提交”的模式已随 2026.11.9 的
# 历史重建废弃，脚本不再维护 snapshot 提交。
#
# 用法：
#   scripts/sync-upstream.sh                       # 拉取并合并；冲突时保留现场
#   scripts/sync-upstream.sh --abort-on-conflict   # CI 用：冲突时中止合并
#   scripts/sync-upstream.sh --continue            # 冲突解决并提交后，记录同步状态
#
# 环境变量：
#   UPSTREAM_REPO    默认 https://github.com/songloft-org/songloft-plugin-miot.git
#   UPSTREAM_BRANCH  默认 main
#   GITHUB_OUTPUT    存在时写出 has_updates / base_sha 供 workflow 使用
#
# 退出码：0 成功或无需同步；1 合并冲突；其他非零为参数/状态/git 执行错误。

set -euo pipefail

DEFAULT_UPSTREAM_REPO="https://github.com/songloft-org/songloft-plugin-miot.git"
UPSTREAM_REPO="${UPSTREAM_REPO:-$DEFAULT_UPSTREAM_REPO}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"

MODE="sync"
ABORT_ON_CONFLICT=0

usage() {
  cat <<'EOF'
把官方上游 songloft-plugin-miot 的主分支合入当前分支。

本仓库以官方 main 为基线 fork（历史共享祖先），直接 git merge 即可。

用法：
  scripts/sync-upstream.sh                       # 拉取并合并；冲突时保留现场
  scripts/sync-upstream.sh --abort-on-conflict   # CI 用：冲突时中止合并
  scripts/sync-upstream.sh --continue            # 冲突解决并提交后，记录同步状态

环境变量：
  UPSTREAM_REPO    默认 https://github.com/songloft-org/songloft-plugin-miot.git
  UPSTREAM_BRANCH  默认 main
  GITHUB_OUTPUT    存在时写出 has_updates / base_sha 供 workflow 使用

退出码：0 成功或无需同步；1 合并冲突；其他非零为参数/状态/git 执行错误。
EOF
}

case "${1:-}" in
  "") ;;
  --abort-on-conflict) ABORT_ON_CONFLICT=1 ;;
  --continue) MODE="continue" ;;
  -h|--help) usage; exit 0 ;;
  *) echo "未知参数: $1（用 --help 查看用法）" >&2; exit 2 ;;
esac

die() { echo "错误: $*" >&2; exit 2; }

set_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1=$2" >> "$GITHUB_OUTPUT"
  fi
}

json_get() {
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = data[process.argv[2]];
    if (value === undefined || value === null) process.exit(3);
    process.stdout.write(String(value));
  ' "$1" "$2"
}

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "当前目录不是 git 仓库"
cd "$ROOT"
GIT_DIR="$(git rev-parse --git-dir)"
STATE="$ROOT/.github/upstream-sync-state.json"
PENDING="$GIT_DIR/upstream-sync-pending.json"
CONFLICT_FILE="$GIT_DIR/upstream-sync-conflicts"

[ -f "$STATE" ] || die "缺少状态文件 $STATE"

STATE_REPO="$(json_get "$STATE" upstreamRepo)" || die "状态文件缺少 upstreamRepo"
STATE_BRANCH="$(json_get "$STATE" upstreamBranch)" || die "状态文件缺少 upstreamBranch"

if [ "$STATE_REPO" != "$UPSTREAM_REPO" ]; then
  die "状态文件记录的上游是 $STATE_REPO，与当前 UPSTREAM_REPO=$UPSTREAM_REPO 不一致。
      如确认要切换上游，请先人工完成一次迁移并更新 $STATE。"
fi
if [ "$STATE_BRANCH" != "$UPSTREAM_BRANCH" ]; then
  die "状态文件记录的上游分支是 $STATE_BRANCH，与当前 UPSTREAM_BRANCH=$UPSTREAM_BRANCH 不一致。"
fi

write_state() {
  local upstream_sha="$1"
  cat > "$STATE" <<EOF
{
  "_comment": "由 scripts/sync-upstream.sh 维护：最后一次成功合入的官方上游提交。请勿手工改动，除非明确知道在做什么。",
  "upstreamRepo": "$UPSTREAM_REPO",
  "upstreamBranch": "$UPSTREAM_BRANCH",
  "lastSyncedSha": "$upstream_sha"
}
EOF
}

commit_state() {
  local upstream_sha="$1"
  write_state "$upstream_sha"
  git add "$STATE"
  if git diff --cached --quiet; then
    echo "同步状态无变化"
  else
    git commit -m "chore(sync): 记录上游同步状态 ${upstream_sha:0:7}"
  fi
  rm -f "$PENDING" "$CONFLICT_FILE"
  echo "已记录同步状态：上游 ${upstream_sha:0:7}"
}

if [ "$MODE" = "continue" ]; then
  [ -f "$PENDING" ] || die "没有待收尾的同步（$PENDING 不存在）"
  [ ! -f "$GIT_DIR/MERGE_HEAD" ] || die "合并尚未完成：请先解决冲突、git add 并 git commit"
  UPSTREAM_SHA="$(json_get "$PENDING" upstreamSha)" || die "待收尾文件缺少 upstreamSha"
  git merge-base --is-ancestor "$UPSTREAM_SHA" HEAD \
    || die "上游提交 $UPSTREAM_SHA 尚未合入当前分支，无法收尾"
  commit_state "$UPSTREAM_SHA"
  exit 0
fi

# 工作区必须干净，避免把无关改动卷进合并提交。
if ! git diff --quiet || ! git diff --cached --quiet; then
  die "工作区存在未提交的改动，请先提交或暂存后再同步"
fi

BASE_SHA="$(git rev-parse HEAD)"
set_output base_sha "$BASE_SHA"

echo "拉取上游 ${UPSTREAM_REPO}@${UPSTREAM_BRANCH} ..."
git fetch --no-tags "$UPSTREAM_REPO" "$UPSTREAM_BRANCH"
UPSTREAM_SHA="$(git rev-parse FETCH_HEAD)"
echo "上游 HEAD: $UPSTREAM_SHA"

if git merge-base --is-ancestor "$UPSTREAM_SHA" HEAD; then
  echo "上游没有新提交，跳过同步"
  set_output has_updates false
  exit 0
fi

cat > "$PENDING" <<EOF
{
  "upstreamSha": "$UPSTREAM_SHA"
}
EOF

echo "合并上游 ${UPSTREAM_SHA:0:7} ..."
if ! git merge --no-ff --no-commit "$UPSTREAM_SHA"; then
  CONFLICTS="$(git diff --name-only --diff-filter=U || true)"
  printf '%s\n' "$CONFLICTS" > "$CONFLICT_FILE"
  echo "合并存在冲突：" >&2
  while IFS= read -r file; do
    [ -n "$file" ] && echo "  - $file" >&2
  done <<< "$CONFLICTS"
  if [ "$ABORT_ON_CONFLICT" = "1" ]; then
    git merge --abort || true
    echo "已中止合并，当前分支未改动。" >&2
  else
    echo "冲突现场已保留。解决后执行：" >&2
    echo "  git add <冲突文件> && git commit" >&2
    echo "  scripts/sync-upstream.sh --continue" >&2
  fi
  exit 1
fi

git commit --allow-empty -m "chore(sync): 合入上游 ${UPSTREAM_BRANCH} ${UPSTREAM_SHA:0:7}"
commit_state "$UPSTREAM_SHA"
set_output has_updates true
echo "同步完成：本地已生成合并提交与状态提交，尚未推送"
