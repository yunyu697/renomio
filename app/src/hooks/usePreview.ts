/** 预览计算入口：模块级缓存，避免多个组件重复跑规则链 */
import { useEffect, useMemo } from 'react';
import { buildPreviewRows, finalizePreview, previewDependsOnOrder, type BuiltRow, type PreviewResult } from '../lib/preview';
import type { EntryFacts, EnvInfo, Entry, MetaFields, Rule } from '../lib/types';
import { useApp } from '../store';

interface Cache {
  entries: Entry[];
  rules: Rule[];
  env: EnvInfo;
  strict: boolean;
  readonly: boolean;
  disk: Record<string, boolean>;
  meta: Record<string, MetaFields>;
  facts: Record<string, EntryFacts>;
  userVars: string[];
  user0: string;
  replaceInvalid: boolean;
  invalidReplacement: string;
  nameMaxLength: number;
  longNameAction: 'block' | 'truncate';
  emptyNameAction: 'block' | 'fallback';
  emptyNameFallback: string;
  skipSystemHidden: boolean;
  nameOverrides: Record<string, string>;
  /** 逐条结果：上下文不变时，纯换序可直接复用，不必重跑规则链 */
  built: BuiltRow[];
  result: PreviewResult;
}

let cache: Cache | null = null;

export function usePreview(): PreviewResult {
  const entries = useApp((s) => s.entries);
  const rules = useApp((s) => s.rules);
  const env = useApp((s) => s.env);
  const strict = useApp((s) => s.settings.strictWindowsNames);
  const readonly = useApp((s) => s.settings.readonlySkip);
  const disk = useApp((s) => s.diskExists);
  const meta = useApp((s) => s.metaFields);
  const facts = useApp((s) => s.fileFacts);
  const userVars = useApp((s) => s.settings.userVars);
  const user0 = useApp((s) => s.settings.userVar0 ?? '');
  const replaceInvalid = useApp((s) => s.settings.replaceInvalid);
  const invalidReplacement = useApp((s) => s.settings.invalidReplacement);
  const nameMaxLength = useApp((s) => s.settings.nameMaxLength ?? 255);
  const longNameAction = useApp((s) => s.settings.longNameAction ?? 'block');
  const emptyNameAction = useApp((s) => s.settings.emptyNameAction ?? 'block');
  const emptyNameFallback = useApp((s) => s.settings.emptyNameFallback ?? '');
  const skipSystemHidden = useApp((s) => s.settings.skipSystemHidden ?? false);
  const nameOverrides = useApp((s) => s.nameOverrides);

  return useMemo(() => {
    const sameContext = !!cache
      && cache.rules === rules
      && cache.env === env
      && cache.strict === strict
      && cache.readonly === readonly
      && cache.disk === disk
      && cache.meta === meta
      && cache.facts === facts
      && cache.userVars === userVars
      && cache.user0 === user0
      && cache.replaceInvalid === replaceInvalid
      && cache.invalidReplacement === invalidReplacement
      && cache.nameMaxLength === nameMaxLength
      && cache.longNameAction === longNameAction
      && cache.emptyNameAction === emptyNameAction
      && cache.emptyNameFallback === emptyNameFallback
      && cache.skipSystemHidden === skipSystemHidden
      && cache.nameOverrides === nameOverrides;

    if (sameContext && cache && cache.entries === entries) return cache.result;

    const opts = {
      env,
      strictWindowsNames: strict,
      readonlySkip: readonly,
      diskExists: disk,
      meta,
      facts,
      userVars,
      user0,
      replaceInvalid,
      invalidReplacement,
      nameMaxLength,
      longNameAction,
      emptyNameAction,
      emptyNameFallback,
      skipSystemHidden,
      nameOverrides,
    };

    // 纯换序（拖拽排序、上移/下移、恢复添加顺序）：逐条结果原样复用，只重跑顺序相关的收尾。
    // 逐条对象身份必须一致，勾选、改名等改动仍然整套重算。
    if (sameContext && cache && !previewDependsOnOrder(rules)) {
      const byId = new Map(cache.built.map((item) => [item.id, item]));
      const built = entries.map((entry) => byId.get(entry.id));
      if (built.length === entries.length && built.every((item, i) => item && item.row.entry === entries[i])) {
        const rows = built as BuiltRow[];
        const result = finalizePreview(rows, opts);
        cache = { ...cache, entries, built: rows, result };
        return result;
      }
    }

    const built = buildPreviewRows(entries, rules, opts);
    const result = finalizePreview(built, opts);
    cache = {
      entries, rules, env, strict, readonly, disk, meta, facts, userVars, user0, replaceInvalid, invalidReplacement,
      nameMaxLength, longNameAction, emptyNameAction, emptyNameFallback, skipSystemHidden, nameOverrides, built, result,
    };
    return result;
  }, [entries, rules, env, strict, readonly, disk, meta, facts, userVars, user0, replaceInvalid, invalidReplacement,
    nameMaxLength, longNameAction, emptyNameAction, emptyNameFallback, skipSystemHidden, nameOverrides]);
}

/** 去抖检查目标是否已存在于磁盘；只由 App 调用一次 */
export function useDiskSync(result: PreviewResult): void {
  const isDemo = useApp((s) => s.isDemo);
  const refreshDisk = useApp((s) => s.refreshDisk);

  useEffect(() => {
    if (isDemo) return;
    let timer = 0;
    const run = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshDisk(result.rows), 260);
    };
    run();
    window.addEventListener('rename:refresh', run);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('rename:refresh', run);
    };
  }, [result, isDemo, refreshDisk]);
}
