import { Navigate, Route, Routes } from 'react-router-dom'
import MainLayout from './layouts/MainLayout'
import Records from './pages/Records'
import Dashboard from './pages/Dashboard'
import CreatorSummary from './pages/CreatorSummary'
import ImportHistory from './pages/ImportHistory'
import RepurchaseRadar from './pages/RepurchaseRadar'
import CreatorPlaybook from './pages/CreatorPlaybook'

export default function App() {
  return (
    <Routes>
      {/* 根路径重定向到数据看板（默认首页） */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/records" element={<MainLayout />}>
        <Route index element={<Records />} />
      </Route>
      {/* 数据看板 */}
      <Route path="/dashboard" element={<MainLayout />}>
        <Route index element={<Dashboard />} />
      </Route>
      {/* 达人汇总 */}
      <Route path="/creators" element={<MainLayout />}>
        <Route index element={<CreatorSummary />} />
      </Route>
      {/* 复投雷达（V3-alpha P1） */}
      <Route path="/repurchase-radar" element={<MainLayout />}>
        <Route index element={<RepurchaseRadar />} />
      </Route>
      {/* 达人拓展（原「新达人判断」；V3-alpha.3 Playbook + 达人拓展信息架构） */}
      <Route path="/creator-playbook" element={<MainLayout />}>
        <Route index element={<CreatorPlaybook />} />
      </Route>
      {/* 导入历史 */}
      <Route path="/import-history" element={<MainLayout />}>
        <Route index element={<ImportHistory />} />
      </Route>
      {/* 未匹配路径统一回到数据看板 */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
