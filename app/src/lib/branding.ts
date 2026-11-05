/**
 * 品牌单一常量：产品名、内部标识、窗口/关于页/通知文案都从这里取。
 * 打包侧对应常量是 src-tauri/src/lib.rs 的 PRODUCT_NAME 与 tauri.conf.json 的 productName，
 * 三处必须保持一致（用户可见处不得再硬编码产品名）。
 */
export const PRODUCT_NAME = 'Renomio';

/** 不变更的内部 crate / 包名，仅供诊断展示。 */
export const INTERNAL_NAME = 'ffrn-core';
