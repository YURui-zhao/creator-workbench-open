/**
 * DEMO_MODE 开关：与 Vercel / Vite 环境变量 VITE_DEMO_MODE 对应。
 * 演示版构建时设为 1；正常业务模式构建不设置该变量，行为与 V1.0.0 完全一致。
 */
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === '1'
