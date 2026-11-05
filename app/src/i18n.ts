import { useSyncExternalStore } from 'react';
import { createI18n, detectLocale, LOCALES, type Locale } from '@foundation';
import { zhCN } from './locales/zh-CN';
import { zhTW } from './locales/zh-TW';
import { enUS } from './locales/en-US';
import { jaJP } from './locales/ja-JP';
import { esES } from './locales/es-ES';

export { LOCALES, detectLocale };
export type { Locale };

export const i18n = createI18n({
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  resources: {
    'zh-CN': zhCN,
    'zh-TW': zhTW,
    'en-US': enUS,
    'ja-JP': jaJP,
    'es-ES': esES,
  },
});

export const t = i18n.t.bind(i18n);
export const isLocale = (value: string): value is Locale => LOCALES.some((l) => l.value === value);

/** 解析初始语言：显式 ?lang= 覆盖 > 用户设置 > 系统语言 > 简体中文。 */
export function resolveLocale(setting: 'system' | Locale): Locale {
  if (typeof window !== 'undefined') {
    const forced = new URLSearchParams(window.location.search).get('lang');
    if (forced && isLocale(forced)) return forced;
  }
  if (setting !== 'system' && isLocale(setting)) return setting;
  const nav = typeof navigator === 'undefined' ? undefined : navigator.language;
  return detectLocale(nav);
}

export function setUiLocale(locale: Locale): void {
  i18n.setLocale(locale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

/** React 侧订阅语言变化：切换语言后立即重渲染使用它的组件。 */
export function useTranslation(): { t: (key: string, vars?: Record<string, string | number>) => string; locale: Locale } {
  const locale = useSyncExternalStore(
    (cb) => i18n.subscribe(() => cb()),
    () => i18n.locale,
    () => i18n.locale,
  );
  return { t: (key, vars) => i18n.t(key, vars), locale };
}
