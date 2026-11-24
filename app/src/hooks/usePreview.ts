/** 预览计算入口：模块级缓存，避免多个组件重复跑规则链 */
import { useEffect, useMemo } from 'react';
import {
  buildPreviewRows, finalizePreview, firstTemplateError, numbersFor, planNumbers,
  previewDependsOnOrder, reorderRows, type BuiltRow, type PreviewResult,
} from '../lib/preview';
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
  sniff: Record<string, string>;
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
  /** 每条当时的号码键：号码没变的行换序后无需重算 */
  numbers: Map<string, string>;
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
  const sniff = useApp((s) => s.sniffTypes);
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

  const result = useMemo(() => {
    const sameContext = !!cache
      && cache.rules === rules
      && cache.env === env
      && cache.strict === strict
      && cache.readonly === readonly
      && cache.disk === disk
      && cache.meta === meta
      && cache.sniff === sniff
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
      sniff,
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

    // 纯换序（拖拽排序、上移/下移、恢复添加顺序）：逐条对象身份必须一致，
    // 勾选、改名等改动仍然整套重算。
    let ordered: BuiltRow[] | null = null;
    if (sameContext && cache && cache.built.length === entries.length) {
      const byId = new Map(cache.built.map((item) => [item.id, item]));
      const mapped = entries.map((entry) => byId.get(entry.id));
      if (mapped.every((item, i) => item && item.row.entry === entries[i])) ordered = mapped as BuiltRow[];
    }

    if (sameContext && cache && ordered) {
      // 编号与顺序无关：逐条结果原样复用，只重跑顺序相关的收尾，结果就是最终值
      if (!previewDependsOnOrder(rules)) {
        const result = finalizePreview(ordered, opts);
        cache = { ...cache, entries, built: ordered, result };
        return result;
      }

      // 编号按列表顺序取号：先算好整表编号，只重算号码变了的行，收尾一次跑完
      const plans = planNumbers(entries, rules, opts);
      const { built, numbers } = reorderRows(entries, rules, opts, plans, firstTemplateError(rules), {
        built: ordered,
        numbers: cache.numbers,
      });
      const result = finalizePreview(built, opts);
      cache = { ...cache, entries, built, numbers, result };
      return result;
    }

    const plans = planNumbers(entries, rules, opts);
    const built = buildPreviewRows(entries, rules, opts, plans, firstTemplateError(rules));
    const result = finalizePreview(built, opts);
    cache = {
      entries, rules, env, strict, readonly, disk, meta, sniff, facts, userVars, user0, replaceInvalid, invalidReplacement,
      nameMaxLength, longNameAction, emptyNameAction, emptyNameFallback, skipSystemHidden, nameOverrides, built,
      numbers: numbersFor(entries, plans), result,
    };
    return result;
  }, [entries, rules, env, strict, readonly, disk, meta, sniff, facts, userVars, user0, replaceInvalid, invalidReplacement,
    nameMaxLength, longNameAction, emptyNameAction, emptyNameFallback, skipSystemHidden, nameOverrides]);

  return result;
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
