/** 预览计算入口：模块级缓存，避免多个组件重复跑规则链 */
import { useEffect, useMemo } from 'react';
import { computePreview, type PreviewResult } from '../lib/preview';
import type { EnvInfo, Entry, MetaFields, Rule } from '../lib/types';
import { useApp } from '../store';

interface Cache {
  entries: Entry[];
  rules: Rule[];
  env: EnvInfo;
  strict: boolean;
  readonly: boolean;
  disk: Record<string, boolean>;
  meta: Record<string, MetaFields>;
  replaceInvalid: boolean;
  invalidReplacement: string;
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
  const replaceInvalid = useApp((s) => s.settings.replaceInvalid);
  const invalidReplacement = useApp((s) => s.settings.invalidReplacement);

  return useMemo(() => {
    if (
      cache &&
      cache.entries === entries &&
      cache.rules === rules &&
      cache.env === env &&
      cache.strict === strict &&
      cache.readonly === readonly &&
      cache.disk === disk &&
      cache.meta === meta &&
      cache.replaceInvalid === replaceInvalid &&
      cache.invalidReplacement === invalidReplacement
    ) {
      return cache.result;
    }
    const result = computePreview(entries, rules, {
      env,
      strictWindowsNames: strict,
      readonlySkip: readonly,
      diskExists: disk,
      meta,
      replaceInvalid,
      invalidReplacement,
    });
    cache = { entries, rules, env, strict, readonly, disk, meta, replaceInvalid, invalidReplacement, result };
    return result;
  }, [entries, rules, env, strict, readonly, disk, meta, replaceInvalid, invalidReplacement]);
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
