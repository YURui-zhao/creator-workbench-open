#!/usr/bin/env node
// Persistent Sidebar（Negotiation Unification V0.2 附带）
//
// 运行方式：node tests/persistent_sidebar.test.js
// 说明：纯源码级布局契约测试（不启动浏览器、不写数据库）。
//
// 要求：
//   1 sidebar persistent / fixed        2 不覆盖主内容（主内容有 left offset）
//   3 main content 正确 left offset      4 viewport height 自适应
//   5 sidebar 内容过长内部滚动            6 collapsed 状态正常（80 / 200）
//   7 Drawer / Modal overlay 能覆盖 sidebar（z-index < antd 默认 1000）
//   8 Header 层级正常                    9 保持响应式折叠能力（collapsible 未被移除）
//   10 不产生水平跳动（offset 与 sider 宽度一一对应，且有过渡）
const path = require('node:path')
const fs = require('node:fs')

const REPO_ROOT = path.resolve(__dirname, '..')
let passCount = 0
let failCount = 0
const failures = []

function check(label, cond, extra = '') {
  if (cond) {
    passCount += 1
    console.log(`PASS  ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    failCount += 1
    failures.push(`${label}${extra ? `  ${extra}` : ''}`)
    console.log(`FAIL  ${label}${extra ? `  ${extra}` : ''}`)
  }
}

const layoutSrc = fs.readFileSync(
  path.join(REPO_ROOT, 'frontend/src/layouts/MainLayout.jsx'),
  'utf8'
)

console.log('===== 1. fixed / persistent =====')
check('Header 固定（position: fixed + top: 0）', /position: 'fixed'[\s\S]{0,80}top: 0/.test(layoutSrc))
check(
  'Sider 固定且从 Header 下方开始（top: HEADER_HEIGHT）',
  /position: 'fixed'[\s\S]{0,200}top: HEADER_HEIGHT/.test(layoutSrc)
)
check(
  'Sider 贴底（bottom: 0）+ 视口高度自适应',
  /bottom: 0[\s\S]{0,140}calc\(100vh - \$\{HEADER_HEIGHT\}px\)/.test(layoutSrc)
)

console.log('\n===== 2. 主内容 offset（不覆盖 / 不水平跳动） =====')
check(
  'main content left offset 跟随 collapsed（80 / 200）',
  /marginInlineStart: collapsed \? 80 : 200/.test(layoutSrc)
)
check('offset 有过渡动画（避免切换时跳动）', /transition: 'margin-inline-start 0\.2s'/.test(layoutSrc))
check(
  'Sider 宽度与 offset 常量一致（200 / 80）',
  /width=\{200\}/.test(layoutSrc) && /collapsedWidth=\{80\}/.test(layoutSrc)
)
check('顶部固定栏为内容留出高度（内层 Layout marginTop）', /marginTop: HEADER_HEIGHT/.test(layoutSrc))
check(
  '主内容区最小高度随视口（不出现底部空白错位）',
  /minHeight: `calc\(100vh - \$\{HEADER_HEIGHT\}px\)`/.test(layoutSrc)
)

console.log('\n===== 3. 溢出滚动 / collapsed =====')
check('sidebar 内容过长时内部滚动（overflow: auto）', /overflow: 'auto'/.test(layoutSrc))
check(
  'collapsed 状态仍可切换（collapsible + onCollapse + trigger=null 自定义按钮）',
  /collapsible/.test(layoutSrc) &&
    /onCollapse=\{setCollapsed\}/.test(layoutSrc) &&
    /trigger=\{null\}/.test(layoutSrc)
)
check('默认收起（collapsed 初值 true，保持既有行为）', /useState\(true\)/.test(layoutSrc))
check(
  '保持在 Layout 内（Outlet / Content 未被破坏）',
  /<Outlet \/>/.test(layoutSrc) && /<Content/.test(layoutSrc)
)

console.log('\n===== 4. 层级（Header / Sider / Modal overlay） =====')
const headerZ = /zIndex: 20/.test(layoutSrc) ? 20 : 0
const siderZ = /zIndex: 15/.test(layoutSrc) ? 15 : 0
check('Header z-index 与 Sider z-index 都已声明', headerZ === 20 && siderZ === 15)
check(
  '两者都低于 antd Modal / Drawer 默认层级 1000（弹层可覆盖侧栏）',
  headerZ < 1000 && siderZ < 1000
)
check('Header 层级高于 Sider（顶部导航不被侧栏压住）', headerZ > siderZ)

console.log('\n===== 5. 页面无自带 fixed 侧栏（布局回归检查） =====')
const pages = ['Dashboard', 'Records', 'RepurchaseRadar', 'CreatorPlaybook']
let pageFixedSidebar = 0
for (const page of pages) {
  const file = path.join(REPO_ROOT, 'frontend/src/pages', page, 'index.jsx')
  if (!fs.existsSync(file)) continue
  const src = fs.readFileSync(file, 'utf8')
  if (/<Sider/.test(src)) pageFixedSidebar += 1
}
check(
  'Dashboard / Records / Radar / Candidate 不各自实现固定侧栏（布局只在 MainLayout）',
  pageFixedSidebar === 0
)

const total = passCount + failCount
const rate = total ? ((passCount / total) * 100).toFixed(1) : '0.0'
console.log('\n================ 测试汇总 ================')
console.log(`用例总数：${total}　通过：${passCount}　失败：${failCount}　通过率：${rate}%`)
if (failCount > 0) {
  console.log('\n失败用例：')
  failures.forEach((item) => console.log(`  - ${item}`))
}
process.exitCode = failCount > 0 ? 1 : 0
