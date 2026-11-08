import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { useTranslation } from '../i18n';
import { metaRestoreBackup, textDetect, textSave } from '../lib/bridge';
import type { Entry, TextDetectDto, TextEncodingId, TextSaveResultDto } from '../lib/types';
import { baseName } from '../lib/format';
import { Icon } from './Icon';

const TARGETS: Array<{ id: TextEncodingId; label: string }> = [
  { id: 'utf8', label: 'UTF-8' },
  { id: 'utf8bom', label: 'UTF-8 with BOM' },
  { id: 'gb18030', label: 'GB18030' },
  { id: 'utf16le', label: 'UTF-16 LE' },
  { id: 'utf16be', label: 'UTF-16 BE' },
];

const SOURCES: Array<{ id: TextEncodingId | 'auto'; labelKey?: string; label?: string }> = [
  { id: 'auto', labelKey: 'text.autoDetect' },
  ...TARGETS,
];

/**
 * 文本编码主体：探测源编码 → 选择目标编码 → 原地覆盖（自动 .bak）或另存；写完回读校验。
 * 旧整页与右侧检查器共用这一份实现，目标都来自同一份文件列表勾选。
 */
export function TextEncodingBody({ targets }: { targets: Entry[] }) {
  const { t } = useTranslation();
  const showToast = useApp((s) => s.showToast);
  const refresh = useApp((s) => s.refreshEntriesFromDisk);

  const [active, setActive] = useState<string | null>(null);
  const [detected, setDetected] = useState<TextDetectDto | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [source, setSource] = useState<TextEncodingId | 'auto'>('auto');
  const [target, setTarget] = useState<TextEncodingId>('utf8');
  const [saveAs, setSaveAs] = useState(false);
  const [output, setOutput] = useState('');
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<TextSaveResultDto | null>(null);
  const [restoring, setRestoring] = useState(false);

  const current = useMemo(
    () => targets.find((f) => f.path === active) ?? targets[0] ?? null,
    [active, targets],
  );

  useEffect(() => {
    if (!current) {
      setDetected(null);
      return;
    }
    if (active !== current.path) setActive(current.path);
    let alive = true;
    setDetecting(true);
    setDetected(null);
    setResult(null);
    void textDetect(current.path)
      .then((info) => {
        if (!alive) return;
        setDetected(info);
        setSource('auto');
        setTarget('utf8');
        setOutput(`${current.path}.utf8.txt`);
      })
      .catch((err) => {
        if (!alive) return;
        showToast('error', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setDetecting(false);
      });
    return () => {
      alive = false;
    };
  }, [current?.path]);

  const manualRequired = detected ? detected.encoding === 'unknown' || !detected.confirmed : false;

  const apply = async () => {
    if (!current) return;
    if (manualRequired && source === 'auto') {
      showToast('warn', t('text.manualRequired'));
      return;
    }
    setApplying(true);
    setResult(null);
    try {
      const out = await textSave({
        path: current.path,
        targetEncoding: target,
        sourceEncoding: source === 'auto' ? null : source,
        saveAs: saveAs ? output : null,
        backup: true,
      });
      setResult(out);
      if (out.ok) showToast('success', t('text.ok', { label: out.targetEncodingLabel }));
      else showToast('error', out.error ?? t('text.fail'));
      void refresh([current.path]);
      if (out.ok) {
        const again = await textDetect(saveAs ? out.outputPath : current.path).catch(() => null);
        if (again) setDetected(again);
      }
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const restore = async () => {
    if (!result?.backup) return;
    setRestoring(true);
    try {
      await metaRestoreBackup(result.backup, result.path);
      showToast('success', t('text.restored'));
      void refresh([result.path]);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(false);
    }
  };

  if (!targets.length || !current) return null;

  return (
    <div className="text-encoding" data-testid="text-editor">
      <div className="text-targets" data-testid="text-targets">
        {targets.map((file, index) => (
          <button
            className={`text-target${file.path === current.path ? ' on' : ''}`}
            type="button"
            key={file.path}
            data-testid={`text-target-${index}`}
            onClick={() => setActive(file.path)}
          >
            <Icon name="text" size={12} />
            <span>{file.name}</span>
            <span className="text-target-ext">{file.parent}</span>
          </button>
        ))}
      </div>

      <div className="text-detect" data-testid="text-detect">
        {detecting && <span>{t('text.detecting')}</span>}
        {!detecting && detected && (
          <>
            <div className="text-detect-line">
              <b>{baseName(detected.path)}</b>
              <span className="meta-format">{detected.encodingLabel}</span>
              <span className={detected.confirmed ? 'ok-chip' : 'warn-chip'} data-testid="text-confirmed">
                {detected.confirmed ? t('text.confirmed') : t('text.unconfirmed')}
              </span>
              <span className="foot-note">
                {t('text.stats', { bytes: detected.bytes, chars: detected.chars, lines: detected.lines })}
              </span>
            </div>
            {detected.preview && <div className="text-preview">“{detected.preview}”</div>}
            {detected.warnings.map((w) => (
              <div className="text-warn" key={w} data-testid="text-warning"><Icon name="alert" size={12} />{w}</div>
            ))}
          </>
        )}
      </div>

      <div className="text-form">
        <label>
          <span>{t('text.source')}</span>
          <select
            className="input"
            data-testid="text-source"
            value={source}
            onChange={(e) => setSource(e.target.value as TextEncodingId | 'auto')}
          >
            {SOURCES.map((item) => (
              <option value={item.id} key={item.id}>
                {item.labelKey ? t(item.labelKey) : item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t('text.target')}</span>
          <select className="input" data-testid="text-target" value={target} onChange={(e) => setTarget(e.target.value as TextEncodingId)}>
            {TARGETS.map((item) => (
              <option value={item.id} key={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <label className="text-check">
          <input type="checkbox" data-testid="text-saveas" checked={saveAs} onChange={(e) => setSaveAs(e.target.checked)} />
          <span>{t('text.saveAs')}</span>
        </label>
        {saveAs && (
          <label className="text-output">
            <span>{t('text.output')}</span>
            <input className="input" data-testid="text-output" value={output} onChange={(e) => setOutput(e.target.value)} />
          </label>
        )}
      </div>

      <div className="text-actions">
        <span className="foot-note">{t('text.backupNote')}</span>
        <button className="btn btn-primary" type="button" data-testid="text-apply" disabled={applying || detecting} onClick={() => void apply()}>
          <Icon name="save" size={13} />{applying ? t('text.applying') : t('text.apply')}
        </button>
      </div>

      {result && (
        <div className={`text-result ${result.ok ? 'ok' : 'bad'}`} data-testid="text-result">
          <div className="meta-result-line">
            <Icon name={result.ok ? 'check' : 'alert'} size={12} />
            <strong>{baseName(result.path)}</strong>
            <span className="meta-format">{result.sourceEncodingLabel} → {result.targetEncodingLabel}</span>
            <span className="meta-result-state">{result.ok ? t('text.resultOk') : t('text.resultFail')}</span>
            {result.ok && result.verified && <span className="meta-verified" data-testid="text-verified">{t('meta.verified')}</span>}
            {result.backup && (
              <button className="mini" type="button" data-testid="text-restore" disabled={restoring} onClick={() => void restore()}>
                {restoring ? t('meta.restoring') : t('meta.restore')}
              </button>
            )}
          </div>
          {result.error && <div className="meta-result-msg">{result.error}</div>}
          {result.ok && (
            <div className="meta-result-msg" data-testid="text-result-stats">
              {t('text.resultStats', {
                before: result.bytesBefore,
                after: result.bytesAfter,
                output: result.outputPath,
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
