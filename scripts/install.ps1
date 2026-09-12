# dsh-deepseek-web 一键安装（Windows / PowerShell）
# 用法：irm https://raw.githubusercontent.com/zgrajdnhj7806-svg/dsh-deepseek-web/main/scripts/install.ps1 | iex
# 可自定义 profile：$env:PROFILE="myprofile"; irm ... | iex
param(
    [string]$Profile = $env:PROFILE
)
if ([string]::IsNullOrWhiteSpace($Profile)) { $Profile = "web" }

$ErrorActionPreference = "Stop"

$Owner  = "zgrajdnhj7806-svg"
$Repo   = "dsh-deepseek-web"
$Bundle = "dsh-deepseek-web"

function Say([string]$msg) { Write-Host "[dsh-deepseek-web] $msg" -ForegroundColor Green }
function Die([string]$msg) { Write-Host "[dsh-deepseek-web] 错误：$msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "需要 Node.js >= 20，请先安装：https://nodejs.org"
}
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    Die "未安装 dsh。请先执行：npm install -g @deepseek-ai/dsh"
}
try {
    $nodeMajor = [int]((& node -e "process.stdout.write(String(process.versions.node.split('.').shift()))") | Out-String).Trim()
} catch {
    $nodeMajor = 0
}
if ($nodeMajor -lt 20) { Die "Node.js 版本过低（$nodeMajor.x），需要 >= 20" }

Say "1/2 安装插件包到 profile [$Profile] ..."
& dsh plugin --profile $Profile add "github:$Owner/$Repo"
if ($LASTEXITCODE -ne 0) { Die "dsh plugin add 失败（退出码 $LASTEXITCODE），请检查网络并重试" }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$pkgPath = Join-Path $dshHome "profiles\$Profile\package.json"
if (-not (Test-Path $pkgPath)) { Die "找不到 profile 配置：$pkgPath" }

Say "2/2 把 $Bundle 挂进 bundles 列表 ..."
$pkg = Get-Content -Raw -Path $pkgPath | ConvertFrom-Json
if (-not $pkg.PSObject.Properties.Name.Contains("dsh")) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue @{} }
if (-not $pkg.dsh.PSObject.Properties.Name.Contains("profile")) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue @{} }
if (-not $pkg.dsh.profile.PSObject.Properties.Name.Contains("bundles")) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }

if (@($pkg.dsh.profile.bundles) -contains $Bundle) {
    Say "bundles 已包含 $Bundle，跳过"
} else {
    $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + $Bundle
    $pkg | ConvertTo-Json -Depth 10 | Set-Content -Path $pkgPath -Encoding UTF8
    Say "bundles 已追加：$Bundle"
}

Say "完成！重启 dsh 后生效：dsh --profile $Profile web"
