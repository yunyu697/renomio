import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useDiskSync, usePreview } from './hooks/usePreview';
import { rulesRequireHashes } from './lib/vars';
import { matchesShortcut } from './lib/shortcuts';
import { installDropHandler } from './lib/bridge';
import {
  LEAVE_GRACE_MS, domDepthAfter, dropReduce, dropVisible,
  type DropSignal, type DropState,
} from './lib/dropGate';
import { useTranslation } from './i18n';
import { PRODUCT_NAME } from './lib/branding';
import { useApp } from './store';
import { ActionBar } from './components/ActionBar';
import { BrandMark } from './components/BrandMark';
import { Drawer } from './components/Drawer';
import { ElevationNotice } from './components/ElevationNotice';
import { FailureDialog } from './components/FailureDialog';
import { MainPane } from './components/MainPane';
import { MetadataDialog } from './components/MetadataDialog';
import { MetaEditDialog } from './components/MetaEditDialog';
import { Nav } from './components/Nav';
import { PlanDialog } from './components/PlanDialog';
import { PlansDialog } from './components/PlansDialog';
import { PathBar } from './components/PathBar';
import { PreviewDialog } from './components/PreviewDialog';
import { ShortcutDialog } from './components/ShortcutDialog';
import { SnapshotDialog } from './components/SnapshotDialog';
import { RulesPanel } from './components/RulesPanel';
import { StatusBar } from './components/StatusBar';
import { Toast } from './components/Toast';
import { Toolbar } from './components/Toolbar';
import { Titlebar } from './components/Titlebar';
import { Icon } from './components/Icon';
import { Inspector } from './components/Inspector';

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
  const setLayout = useApp((s) => s.setLayout);
  const panesRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [dragSize, setDragSize] = useState<number | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const inspectorOpen = useApp((s) => s.inspector.open);
  const rules = useApp((s) => s.rules);
  const layout = settings.layout;
  const sideView = layout.view === 'files-left' || layout.view === 'rules-left';
  const rulesFirst = layout.view === 'rules-left' || layout.view === 'rules-top';
  const compact = layout.view === 'compact';
  // 每个视图各自记住尺寸；旧字段 side/stack 只作缺省值，读取时统一 clamp
  const presetSize = clamp(
    layout.sizes?.[layout.view] ?? (sideView ? layout.side : layout.stack),
    sideView ? 300 : 160,
    sideView ? 900 : 720,
  );

  /** 窄窗自动收敛为单列（按工作区真实宽度判断，宽窗恢复后回落到用户选择的视图）。 */
  useEffect(() => {
    const el = workspaceRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setNarrow((prev) => {
        // 回滞：收窄 <1280、放宽 >1360 才切回，避免在阈值附近抖动
        if (prev) return width < 1360;
        return width < 1280;
      });
    });
    observer.observe(el);
    setNarrow(el.getBoundingClientRect().width < 1280);
    return () => observer.disconnect();
  }, [ready]);

  /** 高级模式下拖动分隔条；松手时把尺寸写进设置（重启后保留）。 */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!layout.advanced) return;
    const panes = panesRef.current;
    if (!panes) return;
    const rect = panes.getBoundingClientRect();
    const horizontal = sideView;
    let last = presetSize;
    const move = (e: PointerEvent) => {
      if (horizontal) {
        const raw = rulesFirst ? e.clientX - rect.left : rect.right - e.clientX;
        last = clamp(raw, 300, Math.max(300, Math.min(rect.width - 320, rect.width * 0.62)));
      } else {
        const raw = rulesFirst ? e.clientY - rect.top : rect.bottom - e.clientY;
        last = clamp(raw, 180, Math.max(180, Math.min(rect.height - 240, rect.height * 0.7)));
      }
      setDragSize(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragSize(null);
      setLayout({ sizes: { ...layout.sizes, [layout.view]: Math.round(last) } });
    };
    event.preventDefault();
    setDragSize(presetSize);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const splitter = layout.advanced ? (
    <div
      className="splitter active"
      role="separator"
      aria-orientation={sideView ? 'vertical' : 'horizontal'}
      aria-label={t('layout.resize')}
      data-testid="layout-splitter"
      data-enabled="true"
      onPointerDown={startResize}
    />
  ) : null;

  const compactBar = (
    <div className="compact-bar">
      <button
        className={`compact-toggle${layout.compactOpen ? ' open' : ''}`}
        type="button"
        data-testid="compact-toggle"
        aria-expanded={layout.compactOpen}
        onClick={() => setLayout({ compactOpen: !layout.compactOpen })}
      >
        <Icon name="rules" size={13} />
        {t('layout.compactToggle', { count: rules.length })}
        <span className={`chev${layout.compactOpen ? '' : ' down'}`}>▾</span>
      </button>
    </div>
  );

  const panes = compact ? (
    <>
      <MainPane />
      {compactBar}
      {layout.compactOpen && <RulesPanel />}
    </>
  ) : rulesFirst ? (
    <>
      <RulesPanel />
      {splitter}
      <MainPane />
    </>
  ) : (
    <>
      <MainPane />
      {splitter}
      <RulesPanel />
    </>
  );
  const dismissMigrationNotice = useApp((s) => s.dismissMigrationNotice);
  /** Esc 时强制复位拖放提示（窗口内按 Esc 取消拖拽时未必收到 leave）。 */
  const dropResetRef = useRef<() => void>(() => undefined);
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

  // 「按元数据取名」与「按字段分组编号」需要先把 EXIF / ID3 字段读进来；只在规则启用时读，避免无谓 I/O
  const entries = useApp((s) => s.entries);
  const loadMetaFields = useApp((s) => s.loadMetaFields);
  useEffect(() => {
    const needMeta = rules.some(
      (r) => r.enabled && (r.type === 'meta' || (r.type === 'number' && r.groupBy.startsWith('field:'))),
    );
    if (!needMeta) return;
    const paths = entries.map((e) => e.path);
    if (paths.length) void loadMetaFields(paths);
  }, [rules, entries, loadMetaFields]);

  // 名称模板引用了 <CRC32>/<MD5>/<SHA1> 时按需流式计算；进度与取消由 store 统一维护
  const loadFileFacts = useApp((s) => s.loadFileFacts);
  useEffect(() => {
    const algos = rulesRequireHashes(rules);
    if (!algos.length) return;
    // 只计算会参与执行的行；取消勾选/重新勾选会因 entries 变化重新触发
    const paths = entries.filter((e) => e.selected).map((e) => e.path);
    if (paths.length) void loadFileFacts(paths, algos);
  }, [rules, entries, loadFileFacts]);

  useEffect(() => {
    let dispose: () => void = () => undefined;
    let alive = true;
    let state: DropState = { status: 'idle' };
    let leaveTimer: number | null = null;
    let domDepth = 0;

    const clearLeaveTimer = () => {
      if (leaveTimer !== null) {
        window.clearTimeout(leaveTimer);
        leaveTimer = null;
      }
    };
    const apply = (signal: DropSignal) => {
      clearLeaveTimer();
      state = dropReduce(state, signal, performance.now());
      if (state.status === 'leaving') {
        leaveTimer = window.setTimeout(() => {
          leaveTimer = null;
          state = { status: 'idle' };
          setDragging(false);
        }, LEAVE_GRACE_MS);
      }
      setDragging(dropVisible(state, performance.now()));
    };
    const reset = () => {
      domDepth = 0;
      apply({ kind: 'cancel' });
    };
    dropResetRef.current = reset;

    void installDropHandler(
      (paths) => {
        apply({ kind: 'drop', files: paths.length });
        if (!paths.length) return;
        useApp.getState().showToast('info', t('app.dropReceived', { count: paths.length }));
        void addPaths(paths);
      },
      (phase, files) => {
        if (phase === 'enter') apply({ kind: 'enter', files });
        else if (phase === 'over') apply({ kind: 'over' });
        else if (phase === 'leave') apply({ kind: 'leave' });
      },
    ).then((fn) => {
      if (alive) dispose = fn;
      else fn();
    });

    /** 只有真正携带文件的外部拖拽才显示文件拖放遮罩；规则卡片的内部拖拽不误触发。 */
    const isFileDrag = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).some((type) => type.toLowerCase() === 'files');
    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      domDepth = domDepthAfter(domDepth, 1);
      apply({ kind: 'enter', files: e.dataTransfer?.files?.length || 1 });
    };
    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (domDepth > 0) apply({ kind: 'over' });
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      domDepth = domDepthAfter(domDepth, -1);
      if (domDepth === 0) apply({ kind: 'leave' });
    };
    const onDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      domDepth = 0;
      apply({ kind: 'drop', files: e.dataTransfer?.files?.length || 1 });
      if (isDemo) {
        useApp.getState().showToast('info', t('app.demoDrop'));
      }
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', onDrop);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      alive = false;
      dispose();
      clearLeaveTimer();
      dropResetRef.current = () => undefined;
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [addPaths, isDemo, setDragging, t]);

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      const state = useApp.getState();
      // 键位窗打开时由其自行处理 Esc 与录制，避免误触全局命令
      if (state.shortcutOpen) return;
      const mod = e.ctrlKey || e.metaKey;
      const maps = state.settings.shortcuts;
      if (!mod && !e.altKey) {
        if (e.key === 'Escape') {
          dropResetRef.current();
          if (state.previewOpen) state.closePreview();
          else if (state.inspector.open) state.closeInspector();
          else if (state.drawer) state.closeDrawer();
          else if (state.ruleMenuOpen) useApp.setState({ ruleMenuOpen: false });
        }
        return;
      }
      if (matchesShortcut(e, maps.search)) {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
        return;
      }
      if (matchesShortcut(e, maps.addFiles)) {
        e.preventDefault();
        void state.chooseFiles();
        return;
      }
      if (matchesShortcut(e, maps.addFolder)) {
        e.preventDefault();
        void state.chooseFolder();
        return;
      }
      if (matchesShortcut(e, maps.preview)) {
        e.preventDefault();
        state.openPreview();
        return;
      }
      if (matchesShortcut(e, maps.undo) && !isTyping(e.target)) {
        e.preventDefault();
        void state.undoLast();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ready) {
    return (
      <div className="boot">
        <BrandMark size={34} />
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
      <div
        className="workspace"
        ref={workspaceRef}
        data-view={settings.layout.view}
        data-advanced={settings.layout.advanced}
        data-narrow={narrow ? 'true' : 'false'}
      >
        <Nav open={narrow && navOpen} onNavigate={() => setNavOpen(false)} />
        {narrow && (
          <>
            <button
              className={`nav-fab${navOpen ? ' open' : ''}`}
              type="button"
              data-testid="nav-fab"
              aria-expanded={navOpen}
              onClick={() => setNavOpen((v) => !v)}
            >
              <Icon name="menu" size={15} />
            </button>
            <div className="narrow-notice" data-testid="narrow-notice">
              <Icon name="info" size={12} />{t('layout.narrow')}
            </div>
          </>
        )}
        <div className="workbench">
          <div
            className="panes"
            ref={panesRef}
            data-view={settings.layout.view}
            data-dragging={dragSize !== null ? 'true' : 'false'}
            style={{
              '--rules-side': `${dragSize ?? presetSize}px`,
              '--rules-stack': `${dragSize ?? presetSize}px`,
            } as CSSProperties}
          >
            {panes}
          </div>
          {inspectorOpen && <Inspector />}
        </div>
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
      <MetaEditDialog />
      <PlanDialog />
      <PlansDialog />
      <SnapshotDialog />
      <ShortcutDialog />
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
