/**
 * 轻量 i18n：无框架依赖，React / CLI / Node 均可复用。
 * 业务工程通过 createI18n() 注册自己的词条，公共词条在 common* 中。
 *
 * 支持的语言：简体中文、繁体中文、English、日本語、Español。
 * 默认跟随系统语言；无法匹配时回落简体中文。
 */
export type Locale = 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'es-ES';
export type Dict = Record<string, string>;
export type Resources = Partial<Record<Locale, Dict>>;

export const LOCALES: Array<{ value: Locale; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'es-ES', label: 'Español' },
];

/** 各业务共用词条（按钮、通用状态、单位） */
export const commonZh: Dict = {
  'common.ok': '确定',
  'common.cancel': '取消',
  'common.apply': '应用',
  'common.close': '关闭',
  'common.delete': '删除',
  'common.retry': '重试',
  'common.loading': '加载中…',
  'common.empty': '暂无内容',
  'common.unsupported': '当前环境不支持',
  'common.localOnly': '本地处理，不上传任何内容',
  'common.unknownError': '未知错误',
  'state.ready': '就绪',
  'state.running': '执行中',
  'state.done': '已完成',
  'state.failed': '失败',
  'state.cancelled': '已取消',
  'unit.items': '个对象',
  'unit.files': '个文件',
};

export const commonZhTW: Dict = {
  'common.ok': '確定',
  'common.cancel': '取消',
  'common.apply': '套用',
  'common.close': '關閉',
  'common.delete': '刪除',
  'common.retry': '重試',
  'common.loading': '載入中…',
  'common.empty': '暫無內容',
  'common.unsupported': '目前環境不支援',
  'common.localOnly': '本機處理，不上傳任何內容',
  'common.unknownError': '未知錯誤',
  'state.ready': '就緒',
  'state.running': '執行中',
  'state.done': '已完成',
  'state.failed': '失敗',
  'state.cancelled': '已取消',
  'unit.items': '個物件',
  'unit.files': '個檔案',
};

export const commonEn: Dict = {
  'common.ok': 'OK',
  'common.cancel': 'Cancel',
  'common.apply': 'Apply',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.empty': 'Nothing here',
  'common.unsupported': 'Not supported in this environment',
  'common.localOnly': 'Processed locally — nothing is uploaded',
  'common.unknownError': 'Unknown error',
  'state.ready': 'Ready',
  'state.running': 'Running',
  'state.done': 'Done',
  'state.failed': 'Failed',
  'state.cancelled': 'Cancelled',
  'unit.items': 'items',
  'unit.files': 'files',
};

export const commonJa: Dict = {
  'common.ok': 'OK',
  'common.cancel': 'キャンセル',
  'common.apply': '適用',
  'common.close': '閉じる',
  'common.delete': '削除',
  'common.retry': '再試行',
  'common.loading': '読み込み中…',
  'common.empty': '内容がありません',
  'common.unsupported': 'この環境では未対応です',
  'common.localOnly': 'ローカル処理のみ。アップロードは行いません',
  'common.unknownError': '不明なエラー',
  'state.ready': '準備完了',
  'state.running': '実行中',
  'state.done': '完了',
  'state.failed': '失敗',
  'state.cancelled': 'キャンセル済み',
  'unit.items': '件',
  'unit.files': 'ファイル',
};

export const commonEs: Dict = {
  'common.ok': 'Aceptar',
  'common.cancel': 'Cancelar',
  'common.apply': 'Aplicar',
  'common.close': 'Cerrar',
  'common.delete': 'Eliminar',
  'common.retry': 'Reintentar',
  'common.loading': 'Cargando…',
  'common.empty': 'Sin contenido',
  'common.unsupported': 'No compatible con este entorno',
  'common.localOnly': 'Procesamiento local, sin subir nada',
  'common.unknownError': 'Error desconocido',
  'state.ready': 'Listo',
  'state.running': 'Ejecutando',
  'state.done': 'Completado',
  'state.failed': 'Fallido',
  'state.cancelled': 'Cancelado',
  'unit.items': 'elementos',
  'unit.files': 'archivos',
};

const COMMON: Record<Locale, Dict> = {
  'zh-CN': commonZh,
  'zh-TW': commonZhTW,
  'en-US': commonEn,
  'ja-JP': commonJa,
  'es-ES': commonEs,
};

/** 系统语言标签 → 支持的 locale；无法匹配时回落 zh-CN。 */
export function detectLocale(tag?: string): Locale {
  const raw = (tag ?? '').replace(/_/g, '-').toLowerCase();
  if (!raw) return 'zh-CN';
  if (raw.startsWith('zh-tw') || raw.startsWith('zh-hk') || raw.startsWith('zh-hant') || raw.startsWith('zh-mo')) return 'zh-TW';
  if (raw.startsWith('zh')) return 'zh-CN';
  if (raw.startsWith('en')) return 'en-US';
  if (raw.startsWith('ja')) return 'ja-JP';
  if (raw.startsWith('es')) return 'es-ES';
  return 'zh-CN';
}

export interface I18nOptions {
  locale?: Locale;
  fallbackLocale?: Locale;
  resources?: Resources;
}

export class I18n {
  private current: Locale;
  private readonly fallback: Locale;
  private readonly resources: Resources;
  private listeners = new Set<(locale: Locale) => void>();

  constructor(opts: I18nOptions = {}) {
    this.current = opts.locale ?? 'zh-CN';
    this.fallback = opts.fallbackLocale ?? 'zh-CN';
    const merged: Resources = {};
    for (const locale of Object.keys(COMMON) as Locale[]) {
      merged[locale] = { ...COMMON[locale], ...(opts.resources?.[locale] ?? {}) };
    }
    this.resources = merged;
  }

  get locale(): Locale {
    return this.current;
  }

  setLocale(locale: Locale): void {
    if (locale === this.current) return;
    this.current = locale;
    this.listeners.forEach((fn) => fn(locale));
  }

  subscribe(fn: (locale: Locale) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  has(key: string, locale: Locale = this.current): boolean {
    return Boolean(this.resources[locale]?.[key] ?? this.resources[this.fallback]?.[key]);
  }

  /** 取词条并插值：{name} / {count} */
  t(key: string, vars?: Record<string, string | number>): string {
    const raw = this.resources[this.current]?.[key] ?? this.resources[this.fallback]?.[key] ?? key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (m, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
    );
  }
}

export function createI18n(opts: I18nOptions = {}): I18n {
  return new I18n(opts);
}
