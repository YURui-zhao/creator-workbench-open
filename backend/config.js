// 全局业务配置
// 默认业务年份为 2026，可通过环境变量 BUSINESS_YEAR 修改
const config = {
  businessYear: Number(process.env.BUSINESS_YEAR) || 2026
}

export default config
