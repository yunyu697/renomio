import { useEffect, useLayoutEffect } from 'react';
import { useDiskSync, usePreview } from './hooks/usePreview';
import { installDropHandler } from './lib/bridge';
import { useTranslation } from './i18n';
import { PRODUCT_NAME } from './lib/branding';
import { useApp } from './store';
import { ActionBar } from './components/ActionBar';
import { Drawer } from './components/Drawer';
import { ElevationNotice } from './components/ElevationNotice';
import { FailureDialog } from './components/FailureDialog';
import { MainPane } from './components/MainPane';
import { MetadataDialog } from './components/MetadataDialog';
import { Nav } from './components/Nav';
import { OpsDialog } from './components/OpsDialog';
import { PlanDialog } from './components/PlanDialog';
import { PathBar } from './components/PathBar';
import { PreviewDialog } from './components/PreviewDialog';
import { RulesPanel } from './components/RulesPanel';
import { StatusBar } from './components/StatusBar';
import { Toast } from './components/Toast';
import { Toolbar } from './components/Toolbar';
import { Titlebar } from './components/Titlebar';
import { Icon } from './components/Icon';

export function App() {
  const { t } = useTranslation();
  const ready = useApp((s) => s.ready);
  const bootError = useApp((s) => s.bootError);
  const isDemo = useApp((s) => s.isDemo);
  const init = useApp((s) => s.init);
  const addPaths = useApp((s) => s.addPaths);
  const dragging = useApp((s) => s.dragging);
  const setDragging = useApp((s) => s.setDragging);
  const preview = usePreview();
  const migration = useApp((s) => s.migration);
  const settings = useApp((s) => s.settings);
  const dismissMigrationNotice = useApp((s) => s.dismissMigrationNotice);
  useDiskSync(preview);

  // React 首次提交（commit）时间，供启动分段统计；并通知入口显窗（保证内容已提交再显示）
  useLayoutEffect(() => {
    const w = window as unknown as { __FIRST_COMMIT_MS__?: number };
    if (w.__FIRST_COMMIT_MS__ === undefined) {
      w.__FIRST_COMMIT_MS__ = performance.now();
      window.dispatchEvent(new Event('app-first-commit'));
    }
  }, []);

  useEffect(() => {
    void init();
  }, [init]);

  // 「按元数据取名」需要先把 EXIF / ID3 字段读进来；只在规则启用时读，避免无谓 I/O
  const rules = useApp((s) => s.rules);
  const entries = useApp((s) => s.entries);
  const loadMetaFields = useApp((s) => s.loadMetaFields);
  useEffect(() => {
    if (!rules.some((r) => r.type === 'meta' && r.enabled)) return;
    const paths = entries.map((e) => e.path);
    if (paths.length) void loadMetaFields(paths);
  }, [rules, entries, loadMetaFields]);

  useEffect(() => {
    let dispose: () => void = () => undefined;
    let alive = true;
    void installDropHandler(
      (paths) => {
        setDragging(false);
        if (!paths.length) return;
        useApp.getState().showToast('info', t('app.dropReceived', { count: paths.length }));
        void addPaths(paths);
      },
      (phase) => setDragging(phase === 'enter' || phase === 'over'),
    ).then((fn) => {
      if (alive) dispose = fn;
      else fn();
    });

    /** 只有真正携带文件的外部拖拽才显示文件拖放遮罩；规则卡片的内部拖拽不误触发。 */
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).some((type) => type.toLowerCase() === 'files');
    const prevent = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.type === 'dragover' || e.type === 'dragenter') setDragging(true);
      if (e.type === 'dragleave' && e.relatedTarget === null) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDragging(false);
      if (isDemo) {
        useApp.getState().showToast('info', t('app.demoDrop'));
      }
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('dragenter', prevent);
    window.addEventListener('dragleave', prevent);
    window.addEventListener('drop', onDrop);
    return () => {
      alive = false;
      dispose();
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('dragenter', prevent);
      window.removeEventListener('dragleave', prevent);
      window.removeEventListener('drop', onDrop);
    };
  }, [addPaths, isDemo, setDragging, t]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) {
        if (e.key === 'Escape') {
          const state = useApp.getState();
          if (state.previewOpen) state.closePreview();
          else if (state.opsMode) state.closeOps();
          else if (state.drawer) state.closeDrawer();
          else if (state.ruleMenuOpen) useApp.setState({ ruleMenuOpen: false });
        }
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
        return;
      }
      if (key === 'o') {
        e.preventDefault();
        void (e.shiftKey ? useApp.getState().chooseFolder() : useApp.getState().chooseFiles());
        return;
      }
      if (key === 'enter') {
        e.preventDefault();
        useApp.getState().openPreview();
        return;
      }
      if (key === 'z' && !isTyping(e.target)) {
        e.preventDefault();
        void useApp.getState().undoLast();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ready) {
    return (
      <div className="boot">
        <span className="tb-mark" style={{ width: 34, height: 34 }}>
          <Icon name="mark" size={18} />
        </span>
        <div>{t('app.booting', { product: PRODUCT_NAME })}</div>
      </div>
    );
  }

  return (
    <div className={`win ${dragging ? 'dragging' : ''}`}>
      <Titlebar />
      <Toolbar />
      {isDemo && (
        <div className="demo-strip">
          <Icon name="info" size={13} />
          {t('app.demoStrip')}
          <code>npm run tauri dev</code>
        </div>
      )}
      <PathBar />
      <ElevationNotice />
      {!settings.migrationNoticeDismissed && migration?.status === 'migrated' && (
        <div className="demo-strip" data-testid="migration-notice">
          <Icon name="info" size={13} />
          {t('migration.notice', { files: migration.files })}
          <button className="btn btn-ghost" type="button" data-testid="migration-dismiss" onClick={dismissMigrationNotice}>
            {t('common.close')}
          </button>
        </div>
      )}
      {!settings.migrationNoticeDismissed && migration?.status === 'failed' && (
        <div className="demo-strip" data-testid="migration-failed">
          <Icon name="alert" size={13} />
          {t('migration.failed', { error: migration.error ?? '' })}
          <button className="btn btn-ghost" type="button" onClick={dismissMigrationNotice}>
            {t('common.close')}
          </button>
        </div>
      )}
      <div className="workspace">
        <Nav />
        <MainPane />
        <RulesPanel />
      </div>
      <ActionBar />
      <StatusBar />

      {bootError && (
        <div className="boot-error">
          <Icon name="alert" size={16} />
          <span>{t('app.bootError', { message: bootError })}</span>
          <button className="btn btn-ghost" type="button" onClick={() => void init()}>{t('common.retry')}</button>
        </div>
      )}

      <PreviewDialog />
      <FailureDialog />
      <MetadataDialog />
      <OpsDialog />
      <PlanDialog />
      <Drawer />
      <Toast />

      {dragging && (
        <div className="drop-overlay" data-testid="drop-overlay">
          <div className="drop-card">
            <Icon name="folder-plus" size={28} />
            <div>{t('app.dropTitle')}</div>
            <small>{t('app.dropHint')}</small>
          </div>
        </div>
      )}
    </div>
  );
}
