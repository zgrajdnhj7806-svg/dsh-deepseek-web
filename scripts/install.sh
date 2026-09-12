#!/usr/bin/env bash
# dsh-deepseek-web 一键安装（macOS / Linux）
# 用法：curl -fsSL https://raw.githubusercontent.com/zgrajdnhj7806-svg/dsh-deepseek-web/main/scripts/install.sh | bash
# 可自定义 profile：PROFILE=myprofile bash install.sh
set -euo pipefail

OWNER="zgrajdnhj7806-svg"
REPO="dsh-deepseek-web"
BUNDLE_ID="dsh-deepseek-web"
PROFILE="${PROFILE:-web}"

say() { printf '\033[1;32m[dsh-deepseek-web]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[dsh-deepseek-web]\033[0m 错误：%s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "需要 Node.js >= 20（推荐 >= 22.19），请先安装：https://nodejs.org"
command -v dsh >/dev/null 2>&1 || die '未安装 dsh。请先执行：npm install -g @deepseek-ai/dsh'
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 版本过低（当前 $NODE_MAJOR.x，需要 >= 20）"

say "1/2 安装插件包到 profile [$PROFILE] ..."
dsh plugin --profile "$PROFILE" add "github:${OWNER}/${REPO}"

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PKG_PATH="${DSH_HOME_DIR}/profiles/${PROFILE}/package.json"
[ -f "$PKG_PATH" ] || die "找不到 profile 配置：$PKG_PATH"

say "2/2 把 $BUNDLE_ID 挂进 bundles 列表 ..."
node - "$PKG_PATH" "$BUNDLE_ID" <<'EOF'
const fs = require('fs')
const [pkgPath, bundle] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const bundles = pkg.dsh?.profile?.bundles ?? []
if (bundles.includes(bundle)) {
  console.log(`bundles 已包含 ${bundle}，跳过`)
  process.exit(0)
}
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
pkg.dsh.profile.bundles = [...bundles, bundle]
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`bundles 已追加：${bundle}`)
EOF

say "完成！重启 dsh 后生效：dsh --profile $PROFILE web"
