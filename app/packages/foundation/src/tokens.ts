/**
 * 设计令牌的 JS 形态。
 * 只读用途：图表配色、导出、运行时计算等；样式请使用 tokens.css。
 */
export const color = {
  light: {
    bg: '#eef1f6', panel: '#ffffff', panel2: '#f8fafd', panel3: '#f1f4fa',
    ink: '#131a26', ink2: '#344055', muted: '#6b7688', line: '#e1e6ef',
    accent: '#3358f4', success: '#0f9d63', warn: '#b26a00', danger: '#d92d20',
  },
  dark: {
    bg: '#0b0f16', panel: '#151a23', panel2: '#111620', panel3: '#1a202b',
    ink: '#e8eef9', ink2: '#c2cbdb', muted: '#8d99ad', line: '#242c3a',
    accent: '#7c96ff', success: '#35d398', warn: '#f0b34a', danger: '#ff7b72',
  },
} as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const;

export const fontSize = { xs: 10.5, sm: 11.5, base: 12.5, md: 13, lg: 15, xl: 18 } as const;

export const radius = { sm: 7, md: 10, lg: 14 } as const;
