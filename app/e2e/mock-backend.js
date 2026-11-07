/* 注入到无头浏览器的 Tauri mock 后端。所有磁盘操作都是内存模拟，
 * 用于在“不启动 GUI 窗口”的前提下验证前端交互路径。
 * 测试脚本通过 window.__E2E__ 读写状态。 */
(() => {
  const SEP = '\\';
  const E2E_FILES = [
    { path: 'D:\\e2e\\旅行\\旧照片 001.jpg', size: 2457600, modified: 1735689600000, readonly: false, hidden: false, creation: 1735603200000 },
    { path: 'D:\\e2e\\旅行\\旧照片 002.jpg', size: 1887437, modified: 1735776000000, readonly: false, hidden: false, creation: 1735603200000 },
    { path: 'D:\\e2e\\旅行\\旧照片 003.jpg', size: 990000, modified: 1735862400000, readonly: true, hidden: false, creation: 1735603200000 },
    { path: 'D:\\e2e\\设计\\logo.png', size: 88000, modified: 1735952400000, readonly: false, hidden: false, creation: 1735603200000 },
  ];
  const EXISTING = ['D:\\e2e\\旅行\\旅行_003.jpg'];

  const state = {
    elevated: sessionStorage.getItem('e2e-elevated') === '1',
    denyPaths: [],
    files: E2E_FILES.map((f) => ({ ...f })),
    batches: [],
    snapshots: [],
    planContent: null,
    writes: {},
    binaryWrites: {},
    calls: [],
    metadata: [],
    conflictPolicyNote: '',
    dirs: new Set(['d:\\e2e\\旅行', 'd:\\e2e\\设计']),
    applyOrder: [],
    windowCalls: [],
    eventSeq: 0,
    eventMap: new Map(),
    dragEmits: [],
    progressEvents: [],
    snapshotProgressEvents: [],
  };
  // 通过 URL 参数模拟「首次启动已从 Renomio 之前的版本迁移数据」：?migration=migrated
  const query = new URLSearchParams(location.search);
  if (query.get('migration') === 'migrated') {
    state.migrationInfo = {
      status: 'migrated',
      oldDir: 'C:\\Users\\E2E\\AppData\\Roaming\\com.rename.studio',
      newDir: 'C:\\Users\\E2E\\AppData\\Roaming\\app.renomio.desktop',
      oldDirExists: true,
      files: 3,
      bytes: 8192,
      migratedAt: 1765000000000,
      error: null,
    };
  }
  window.__E2E__ = state;

  /** 向已注册的 Tauri 事件监听器派发事件；返回命中数量。 */
  state.emitEvent = (event, payload) => {
    let hit = 0;
    for (const [id, entry] of state.eventMap) {
      if (entry.event !== event) continue;
      const fn = window[`_${entry.handler}`];
      if (typeof fn === 'function') {
        fn({ event, id, payload });
        hit += 1;
      }
    }
    return hit;
  };

  /** 模拟 Tauri 原生拖放事件：enter / over / drop / leave。返回是否命中已注册监听器。 */
  state.emitDrag = (type, paths) => {
    const event = `tauri://drag-${type}`;
    const payload =
      type === 'drop' || type === 'enter'
        ? { paths: paths || [], position: { x: 120, y: 80 } }
        : type === 'over'
          ? { position: { x: 120, y: 80 } }
          : {};
    const hit = state.emitEvent(event, payload);
    state.dragEmits.push({ type, paths: paths || [], hit });
    return hit;
  };

  const splitPath = (p) => {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return { parent: p.slice(0, i), name: p.slice(i + 1) };
  };
  const key = (p) => p.toLowerCase();
  const entryOf = (file) => {
    const parts = splitPath(file.path);
    return {
      id: file.path,
      path: file.path,
      name: parts.name,
      parent: parts.parent,
      isDir: false,
      size: file.size,
      modified: file.modified,
      readonly: file.readonly,
    };
  };
  const diskKeys = () => new Set([...state.files.map((f) => key(f.path)), ...EXISTING.map(key)]);
  /** 与真实后端一致的确定性「SHA-256」占位值：只依赖大小与修改时间，改名后仍保持不变。 */
  const hashOf = (file) => {
    let h = 2166136261;
    const seed = `${file.size}:${file.modified}`;
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    let x = h >>> 0;
    let out = '';
    for (let i = 0; i < 8; i += 1) {
      out += x.toString(16).padStart(4, '0');
      x = (Math.imul(x ^ 0x9e3779b9, 2654435761) >>> 0);
    }
    return out.slice(0, 64);
  };
  /** 快照还原预览：与 Rust snapshot::plan 的判定顺序保持一致。 */
  const snapshotPlanOf = (snap) => {
    const disk = diskKeys();
    const byKey = indexByPath();
    return snap.entries.map((e, index) => {
      const id = String(index);
      const base = { id, from: e.from, to: e.to, isDir: false, action: 'restore', reasonCode: null, reason: null, hashCheck: Boolean(e.sha256) };
      if (!disk.has(key(e.to))) {
        return disk.has(key(e.from))
          ? { ...base, action: 'skip', reasonCode: 'already-original', reason: '文件已在原名，无需还原' }
          : { ...base, action: 'skip', reasonCode: 'missing', reason: '文件不存在（可能已被移动或删除）' };
      }
      if (disk.has(key(e.from))) {
        return { ...base, action: 'skip', reasonCode: 'occupied', reason: '原位置已被其他文件占用' };
      }
      const idx = byKey.get(key(e.to));
      if (idx === undefined) {
        return { ...base, action: 'skip', reasonCode: 'missing', reason: '文件不存在' };
      }
      if (e.sha256 && hashOf(state.files[idx]) !== e.sha256) {
        return { ...base, action: 'skip', reasonCode: 'changed', reason: '文件内容已变化（SHA-256 不符）' };
      }
      if (!e.sha256 && (state.files[idx].size !== e.size || state.files[idx].modified !== e.mtimeMs)) {
        return { ...base, action: 'skip', reasonCode: 'changed', reason: '文件已变化（大小或修改时间不符）' };
      }
      return base;
    });
  };
  /** 路径 → 数组下标，避免逐条 findIndex 造成 O(n²)（10k 文件时可测出数十秒）。 */
  const indexByPath = () => {
    const map = new Map();
    state.files.forEach((f, i) => map.set(key(f.path), i));
    return map;
  };
  const IMAGE_FIELDS = ['title', 'description', 'keywords', 'author', 'copyright', 'software', 'takenAt', 'headline', 'bylineTitle', 'credit', 'source'];
  const AUDIO_FIELDS = ['title', 'artist', 'album', 'year', 'track', 'genre', 'comment', 'albumArtist', 'lyrics', 'cover'];
  const DOC_FIELDS = ['title', 'subject', 'author', 'lastModifiedBy', 'keywords', 'comment', 'category'];
  const META_DEFAULTS = {
    image: { title: '旧照片', description: '旅行随拍', keywords: '旅行;风景', author: '摄影师', copyright: '© 2025', software: 'Renomio', takenAt: '2024-05-01T10:20:30', headline: '春游', bylineTitle: '摄影记者', credit: '某通讯社', source: '素材库' },
    audio: { title: '旧歌名', artist: '歌手', album: '专辑', year: '2024', track: '3', genre: 'Pop', comment: '备注', albumArtist: '乐队', lyrics: '第一行\n第二行' },
    document: { title: '旧文档标题', subject: '主题', author: '作者', lastModifiedBy: '最后修改者', keywords: '关键词', comment: '备注', category: '类别' },
    other: {},
  };
  /** 与 Rust metaedit::detect 对齐的 mock 快照（含明确拒绝的格式）。 */
  const metaSnapshotOf = (p) => {
    const ext = (p.split('.').pop() || '').toLowerCase();
    let kind = 'other';
    let format = ext ? ext.toUpperCase() : '未知';
    let supportedFields = [];
    let writable = false;
    let unsupportedReason = '不支持的格式';
    if (['jpg', 'jpeg'].includes(ext)) {
      kind = 'image'; format = 'JPEG'; supportedFields = IMAGE_FIELDS; writable = true;
    } else if (ext === 'png') {
      kind = 'image'; format = 'PNG'; supportedFields = IMAGE_FIELDS; writable = true;
    } else if (ext === 'webp') {
      kind = 'image'; format = 'WebP'; supportedFields = IMAGE_FIELDS; writable = true;
    } else if (ext === 'tif' || ext === 'tiff') {
      kind = 'image'; format = 'TIFF'; supportedFields = IMAGE_FIELDS; writable = true;
    } else if (['heic', 'heif', 'avif'].includes(ext)) {
      kind = 'image'; format = ext.toUpperCase(); unsupportedReason = 'HEIC/HEIF 解码能力缺失，本版本不支持';
    } else if (['gif', 'bmp'].includes(ext)) {
      kind = 'image'; format = ext.toUpperCase(); unsupportedReason = '该图片容器不含可编辑 XMP 段';
    } else if (ext === 'mp3') {
      kind = 'audio'; format = 'MP3'; supportedFields = AUDIO_FIELDS; writable = true;
    } else if (ext === 'flac') {
      kind = 'audio'; format = 'FLAC'; supportedFields = AUDIO_FIELDS; writable = true;
    } else if (ext === 'm4a' || ext === 'mp4') {
      kind = 'audio'; format = 'M4A'; supportedFields = AUDIO_FIELDS; writable = true;
    } else if (ext === 'ogg' || ext === 'opus') {
      kind = 'audio'; format = 'OGG'; supportedFields = AUDIO_FIELDS; writable = true;
    } else if (['wma', 'ape', 'aiff', 'aif', 'wav'].includes(ext)) {
      kind = 'audio'; format = ext.toUpperCase(); unsupportedReason = '该音频容器的标签格式本版本未支持';
    } else if (ext === 'pdf') {
      kind = 'document'; format = 'PDF'; supportedFields = DOC_FIELDS; writable = true;
    } else if (['docx', 'xlsx', 'pptx'].includes(ext)) {
      kind = 'document'; format = ext.toUpperCase(); supportedFields = DOC_FIELDS; writable = true;
    }
    const base = { ...META_DEFAULTS[kind], ...((state.meta || {})[p] || {}) };
    return {
      path: p,
      kind,
      format,
      writable,
      supportedFields,
      fields: base,
      cover: null,
      warnings: [],
      unsupportedReason: writable ? null : unsupportedReason,
    };
  };
  /** 与 Rust journal::undo_status 保持一致的撤销可行性判断（基于 mock 磁盘状态）。 */
  const undoStatusOf = (batch) => {
    if (batch.state === 'undone') return [false, '该批次已经撤销'];
    if (batch.state === 'undo-partial') return [false, '上次撤销部分失败，请先检查残留文件'];
    const doneItems = (batch.items || []).filter((i) => i.state === 'done');
    const doneOps = (batch.ops || []).filter((o) => o.state === 'done');
    if (!doneItems.length && !doneOps.length) {
      if (batch.state === 'pending') return [false, '批次未完成；请先恢复执行或清理临时文件'];
      return [false, '批次没有实际执行的条目'];
    }
    const disk = diskKeys();
    for (const item of doneItems) {
      if (!disk.has(key(item.to))) {
        return [false, `目标文件已不存在：${item.to}（可能被外部移动或删除）`];
      }
    }
    for (const op of doneOps) {
      const current = op.target || op.path;
      if (!disk.has(key(current))) {
        return [false, `文件已不存在：${current}（可能被外部移动或删除）`];
      }
    }
    return [true, null];
  };

  const record = (cmd, args) => {
    state.calls.push({ cmd, args, at: Date.now() });
    if (state.calls.length > 4000) state.calls.shift();
  };

  const handlers = {
    env_info: () => ({
      os: 'windows',
      separator: '\\',
      caseSensitive: false,
      componentLimit: 255,
      pathWarnThreshold: 240,
      pathHardLimit: 32767,
      dataDir: 'C:\\Users\\E2E\\AppData\\Roaming\\app.renomio.desktop',
      creationTimeWritable: false,
      longPathSupport: true,
    }),

    privilege_info: () => ({
      elevated: !!state.elevated,
      platform: 'windows',
      exePath: 'C:\\Program Files\\Renomio\\renomio.exe',
      installDir: state.elevated
        ? 'C:\\Program Files\\Renomio'
        : 'C:\\Users\\E2E\\AppData\\Local\\Programs\\Renomio',
      appDataDir: 'C:\\Users\\E2E\\AppData\\Roaming\\app.renomio.desktop',
    }),

    migration_info: () => state.migrationInfo || {
      status: 'no-legacy',
      oldDir: 'C:\\Users\\E2E\\AppData\\Roaming\\com.rename.studio',
      newDir: 'C:\\Users\\E2E\\AppData\\Roaming\\app.renomio.desktop',
      oldDirExists: false,
      files: 0,
      bytes: 0,
      migratedAt: null,
      error: null,
    },

    import_legacy_data: () => {
      state.importRequests = (state.importRequests || 0) + 1;
      return state.importResult || {
        imported: 2,
        skipped: 1,
        bytes: 4096,
        backupDir: 'C:\\Users\\E2E\\AppData\\Roaming\\import-backup-1',
      };
    },

    relaunch_as_admin: () => {
      state.relaunchRequested = true;
      return state.relaunchResult !== undefined ? state.relaunchResult : false;
    },

    rename_fields: (args) => (args?.paths ?? []).map((path) => {
      const name = path.toLowerCase();
      const isPhoto = name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png');
      const isMusic = name.endsWith('.mp3');
      return {
        path,
        taken: isPhoto ? '2024-05-01 08-30-00' : '',
        camera: isPhoto ? 'Canon EOS R6' : '',
        title: isMusic ? (state.audioTitle || 'Summer Night') : '',
        artist: isMusic ? 'E2E Artist' : '',
        album: isMusic ? 'E2E Album' : '',
        track: isMusic ? '2' : '',
      };
    }),

    scan_paths: (args) => {
      const requested = args.paths || [];
      const includeHidden = (args.options || {}).includeHidden !== false;
      const byKey = indexByPath();
      const picked = [];
      for (const p of requested) {
        const index = byKey.get(key(p));
        if (index !== undefined) picked.push(state.files[index]);
      }
      const entries = (picked.length ? picked : state.files)
        .filter((f) => includeHidden || !f.hidden)
        .map(entryOf);
      return { entries, warnings: [], truncated: false, visitedDirs: 2 };
    },

    paths_exist: (args) => {
      const disk = diskKeys();
      return (args.paths || []).map((p) => disk.has(key(p)));
    },

    apply_plan: async (args) => {
      const requested = args.items || [];
      const total = requested.length;
      const emitProgress = (phase, done, current) => {
        const payload = { phase, done, total, current: current || '' };
        state.progressEvents.push({ ...payload, at: Date.now() });
        state.emitEvent('apply-progress', payload);
      };
      // 与真实后端一致的两阶段推进；每条目留一点时间让 UI 绘制进度
      emitProgress('prepare', 0, '');
      for (let i = 0; i < total; i++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        emitProgress('stage', i + 1, splitPath(requested[i].source).name);
      }

      state.applyOrder = (args.items || []).map((it) => it.source);
      const policy = args.options?.policy || 'skip';
      const disk = diskKeys();
      (args.items || []).forEach((it) => disk.delete(key(it.source)));
      const byKey = indexByPath();
      const claimed = new Set();
      const items = [];
      const applied = [];
      const skipped = [];
      const failed = [];
      const now = Date.now();

      for (const it of args.items || []) {
        const source = it.source;
        const parts = splitPath(source);
        let target = `${parts.parent}${SEP}${it.targetName}`;
        const targetKey = key(target);
        let reason = null;
        let backup = null;
        let stateName = 'done';
        let code = null;

        if (state.denyPaths && state.denyPaths.some((p) => key(p) === key(source))) {
          reason = '移动到临时名失败：拒绝访问。 (os error 5)';
          code = 'access-denied';
          stateName = 'failed';
        } else if (claimed.has(targetKey)) {
          reason = '批次内多个项目指向同一目标，已跳过以避免覆盖';
          code = 'conflict';
          stateName = 'skipped';
        } else if (disk.has(targetKey)) {
          if (policy === 'skip') {
            reason = '目标文件已存在';
            stateName = 'skipped';
          } else if (policy === 'suffix') {
            const dot = it.targetName.lastIndexOf('.');
            const stem = dot > 0 ? it.targetName.slice(0, dot) : it.targetName;
            const ext = dot > 0 ? it.targetName.slice(dot) : '';
            let n = 1;
            target = `${parts.parent}${SEP}${stem} (${n})${ext}`;
            while (disk.has(key(target)) || claimed.has(key(target))) {
              n += 1;
              target = `${parts.parent}${SEP}${stem} (${n})${ext}`;
            }
          } else {
            backup = `C:\\Users\\E2E\\AppData\\Roaming\\app.renomio.desktop\\exports-backup\\${now}-${parts.name}`;
          }
        }

        items.push({
          id: it.id,
          from: source,
          to: target,
          temp: '',
          isDir: !!it.isDir,
          state: stateName,
          ...(reason ? { reason } : {}),
          ...(backup ? { backup } : {}),
        });

        if (stateName === 'failed') {
          failed.push({ id: it.id, source, reason, code: code || 'io-error' });
          continue;
        }

        if (stateName === 'skipped') {
          skipped.push({ id: it.id, source, reason, code: code || 'conflict' });
          continue;
        }

        const index = byKey.get(key(source));
        if (index !== undefined) {
          const name = splitPath(target).name;
          byKey.delete(key(source));
          byKey.set(key(target), index);
          state.files[index].path = target;
          state.files[index].name = name;
        }
        claimed.add(targetKey);
        applied.push({ id: it.id, from: source, to: target, ...(backup ? { backup } : {}) });
      }

      const batch = {
        id: `mock-batch-${state.batches.length + 1}`,
        createdAt: now,
        finishedAt: now,
        state: skipped.length || failed.length ? 'partial' : 'completed',
        policy,
        roots: args.options?.roots || [],
        counts: {
          total: items.length,
          done: applied.length,
          skipped: skipped.length,
          failed: failed.length,
        },
        items,
      };
      for (let i = 0; i < total; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        emitProgress('apply', i + 1, requested[i].targetName);
      }
      emitProgress('done', total, '');
      // 批次在“执行完成”后才进入历史，避免测试在进度未结束时读到批次
      state.batches.unshift(batch);
      return { batch, applied, skipped, failed };
    },

    create_snapshot: async (args) => {
      const requested = args.entries || [];
      const total = requested.length;
      const emit = (phase, done, current) => {
        const payload = { phase, done, total, current: current || '' };
        state.snapshotProgressEvents.push({ ...payload, at: Date.now() });
        state.emitEvent('snapshot-progress', payload);
      };
      emit('hash', 0, '');
      const entries = [];
      let skipped = 0;
      const byKey = indexByPath();
      for (const e of requested) {
        await new Promise((resolve) => setTimeout(resolve, 12));
        const idx = byKey.get(key(e.from));
        if (idx === undefined) {
          skipped += 1;
          continue;
        }
        const file = state.files[idx];
        entries.push({
          from: e.from,
          to: e.to,
          size: file.size,
          mtimeMs: file.modified,
          isDir: false,
          ...(args.withHash ? { sha256: hashOf(file) } : {}),
        });
        emit('hash', entries.length, splitPath(e.from).name);
      }
      const snap = {
        schema: 'renomio-snapshot/v1',
        id: `mock-snap-${state.snapshots.length + 1}`,
        createdAt: Date.now(),
        roots: args.roots || [],
        entryCount: entries.length,
        hashed: entries.filter((e) => e.sha256).length,
        skipped,
        entries,
      };
      state.snapshots.unshift(snap);
      emit('done', entries.length, '');
      return snap;
    },

    cancel_snapshot: () => false,

    list_snapshots: () => state.snapshots.map(({ entries, ...rest }) => rest),

    preview_snapshot: (args) => {
      const snap = state.snapshots.find((s) => s.id === args.id);
      if (!snap) throw new Error('快照不存在或已损坏');
      return snapshotPlanOf(snap);
    },

    restore_snapshot: async (args) => {
      const snap = state.snapshots.find((s) => s.id === args.id);
      if (!snap) throw new Error('快照不存在或已损坏');
      const plan = snapshotPlanOf(snap);
      const emit = (phase, done, total, current) => {
        const payload = { phase, done, total, current: current || '' };
        state.snapshotProgressEvents.push({ ...payload, at: Date.now() });
        state.emitEvent('snapshot-progress', payload);
      };
      const skipped = plan
        .filter((p) => p.action === 'skip')
        .map((p) => ({ id: p.id, source: p.to, reason: p.reason || '' }));
      const restorable = plan.filter((p) => p.action === 'restore');
      const hashChecked = restorable.filter((p) => p.hashCheck).length;
      const restored = [];
      const failed = [];
      const items = [];
      const disk = diskKeys();
      restorable.forEach((p) => disk.delete(key(p.to)));
      const byKey = indexByPath();

      emit('verify', 0, restorable.length, '');
      for (let i = 0; i < restorable.length; i += 1) {
        const p = restorable[i];
        await new Promise((resolve) => setTimeout(resolve, 12));
        const idx = byKey.get(key(p.to));
        if (idx === undefined) {
          failed.push({ id: p.id, source: p.to, reason: '源文件不存在' });
          continue;
        }
        emit('apply', i + 1, restorable.length, splitPath(p.to).name);
        byKey.delete(key(p.to));
        byKey.set(key(p.from), idx);
        state.files[idx].path = p.from;
        state.files[idx].name = splitPath(p.from).name;
        items.push({ id: p.id, from: p.to, to: p.from, temp: '', isDir: false, state: 'done' });
        restored.push({ id: p.id, from: p.to, to: p.from });
      }

      const batch = {
        id: `mock-batch-${state.batches.length + 1}`,
        createdAt: Date.now(),
        finishedAt: Date.now(),
        state: skipped.length || failed.length ? 'partial' : 'completed',
        kind: 'restore',
        policy: 'skip',
        roots: snap.roots || [],
        counts: {
          total: plan.length,
          done: restored.length,
          skipped: skipped.length,
          failed: failed.length,
        },
        items,
        ops: [],
      };
      emit('done', restored.length, restored.length, '');
      state.batches.unshift(batch);
      return { batch, restored, skipped, failed, hashChecked };
    },

    delete_snapshot: (args) => {
      state.snapshots = state.snapshots.filter((s) => s.id !== args.id);
      return null;
    },

    undo_batch: (args) => {
      const batch = state.batches.find((b) => b.id === args.id);
      if (!batch) throw new Error(`批次不存在：${args.id}`);
      const restored = [];
      const failed = [];

      if (batch.kind && batch.kind !== 'rename' && batch.kind !== 'restore') {
        for (const op of [...(batch.ops || [])].reverse()) {
          if (op.state !== 'done') continue;
          if (op.kind === 'move') {
            const idx = state.files.findIndex((f) => key(f.path) === key(op.target));
            if (idx < 0) {
              failed.push({ id: op.id, source: op.target, reason: '移动后的文件不存在' });
              continue;
            }
            state.files[idx].path = op.path;
            state.files[idx].name = splitPath(op.path).name;
            op.state = 'skipped';
            restored.push({ id: op.id, from: op.target, to: op.path });
          } else if (op.kind === 'time') {
            const before = JSON.parse(op.before || '{}');
            const file = state.files.find((f) => key(f.path) === key(op.path));
            if (!file) {
              failed.push({ id: op.id, source: op.path, reason: '文件不存在' });
              continue;
            }
            if (before.mtime != null) file.modified = before.mtime;
            if (before.atime != null) file.atime = before.atime;
            if (before.creation != null) file.creation = before.creation;
            op.state = 'skipped';
            restored.push({ id: op.id, from: op.path, to: op.path });
          } else if (op.kind === 'attrs') {
            const before = JSON.parse(op.before || '{}');
            const file = state.files.find((f) => key(f.path) === key(op.path));
            if (!file) {
              failed.push({ id: op.id, source: op.path, reason: '文件不存在' });
              continue;
            }
            file.readonly = !!before.readonly;
            file.hidden = !!before.hidden;
            op.state = 'skipped';
            restored.push({ id: op.id, from: op.path, to: op.path });
          }
        }
        batch.state = failed.length ? 'undo-partial' : 'undone';
        return { batch, restored, failed };
      }

      const byKey = indexByPath();
      for (const it of [...batch.items].reverse()) {
        if (it.state !== 'done') continue;
        const index = byKey.get(key(it.to));
        if (index === undefined) {
          failed.push({ id: it.id, source: it.to, reason: '当前文件不存在' });
          continue;
        }
        const parts = splitPath(it.from);
        byKey.delete(key(it.to));
        byKey.set(key(it.from), index);
        state.files[index].path = it.from;
        state.files[index].name = parts.name;
        it.state = 'skipped';
        restored.push({ id: it.id, from: it.to, to: it.from });
      }
      batch.state = failed.length ? 'undo-partial' : 'undone';
      return { batch, restored, failed };
    },

    list_batches: () =>
      state.batches.map((batch) => {
        const [undoable, undoReason] = undoStatusOf(batch);
        const { items, ops, createdDirs, ...rest } = batch;
        return { ...rest, kind: batch.kind || 'rename', undoable, undoReason };
      }),

    read_times: (args) =>
      (args.paths || []).map((p) => {
        const f = state.files.find((x) => key(x.path) === key(p));
        if (!f) {
          return {
            path: p,
            name: splitPath(p).name,
            atimeMs: null,
            mtimeMs: null,
            creationMs: null,
            creationWritable: false,
            error: '文件不存在',
          };
        }
        return {
          path: p,
          name: splitPath(p).name,
          atimeMs: f.atime ?? f.modified,
          mtimeMs: f.modified,
          creationMs: f.creation,
          creationWritable: false,
          error: null,
        };
      }),

    read_attrs: (args) =>
      (args.paths || []).map((p) => {
        const f = state.files.find((x) => key(x.path) === key(p));
        return {
          path: p,
          name: splitPath(p).name,
          readonly: !!f?.readonly,
          hidden: !!f?.hidden,
          hiddenSupported: true,
          error: f ? null : '文件不存在',
        };
      }),

    apply_time: (args) => {
      const spec = args.spec || {};
      const fields = spec.fields || [];
      const now = Date.now();
      const ops = [];
      const applied = [];
      const skipped = [];
      const failed = [];
      const nextOf = (path, old) => {
        if (spec.mode === 'fixed') return spec.fixedMs;
        if (spec.mode === 'random') {
          const low = Math.min(spec.randomMinMs || 0, spec.randomMaxMs || 0);
          const high = Math.max(spec.randomMinMs || 0, spec.randomMaxMs || 0);
          const span = high - low + 1;
          const bytes = Buffer.from(`${path}\u0001${spec.randomSeed || ''}`, 'utf8');
          let hash = 0x811c9dc5;
          for (const byte of bytes) {
            hash ^= byte;
            hash = Math.imul(hash, 0x01000193) >>> 0;
          }
          return low + (hash % span);
        }
        return old + (Number(spec.shiftSeconds) || 0) * 1000;
      };

      for (const it of args.items || []) {
        const file = state.files.find((x) => key(x.path) === key(it.path));
        if (!file) {
          failed.push({ id: it.id, source: it.path, reason: '文件不存在' });
          ops.push({ id: it.id, kind: 'time', path: it.path, before: '{}', after: '{}', state: 'failed', reason: '文件不存在' });
          continue;
        }
        const before = {
          atime: file.atime ?? file.modified,
          mtime: file.modified,
          creation: file.creation,
        };
        const after = {};
        let changed = false;
        for (const field of fields) {
          const old = field === 'mtime' ? file.modified : field === 'atime' ? before.atime : file.creation;
          const next = nextOf(it.path, old);
          after[field] = next;
          if (next !== old) changed = true;
        }
        const beforeJson = JSON.stringify(before);
        if (!changed) {
          skipped.push({ id: it.id, source: it.path, reason: '时间未变更' });
          ops.push({ id: it.id, kind: 'time', path: it.path, before: beforeJson, after: '{}', state: 'skipped', reason: '时间未变更' });
          continue;
        }
        if (fields.includes('mtime')) file.modified = after.mtime;
        if (fields.includes('atime')) file.atime = after.atime;
        if (fields.includes('creation')) file.creation = after.creation;
        const afterJson = JSON.stringify(after);
        ops.push({ id: it.id, kind: 'time', path: it.path, before: beforeJson, after: afterJson, state: 'done' });
        applied.push({ id: it.id, path: it.path, before: beforeJson, after: afterJson });
      }

      const batch = {
        id: `mock-batch-${state.batches.length + 1}`,
        createdAt: now,
        finishedAt: now,
        state: failed.length ? 'partial' : 'completed',
        kind: 'time',
        policy: 'skip',
        roots: [],
        counts: { total: ops.length, done: applied.length, skipped: skipped.length, failed: failed.length },
        items: [],
        ops,
        createdDirs: [],
      };
      state.batches.unshift(batch);
      return { batch, applied, skipped, failed };
    },

    apply_attrs: (args) => {
      const spec = args.spec || {};
      const now = Date.now();
      const ops = [];
      const applied = [];
      const skipped = [];
      const failed = [];

      for (const it of args.items || []) {
        const file = state.files.find((x) => key(x.path) === key(it.path));
        if (!file) {
          failed.push({ id: it.id, source: it.path, reason: '文件不存在' });
          continue;
        }
        const before = { readonly: !!file.readonly, hidden: !!file.hidden };
        const next = (choice, old) =>
          choice === null || choice === undefined
            ? old
            : choice === 'invert'
              ? !old
              : choice === 'set' || choice === true;
        const after = {
          readonly: next(spec.readonly, before.readonly),
          hidden: next(spec.hidden, before.hidden),
        };
        if (after.readonly === before.readonly && after.hidden === before.hidden) {
          skipped.push({ id: it.id, source: it.path, reason: '属性未变更' });
          ops.push({ id: it.id, kind: 'attrs', path: it.path, before: JSON.stringify(before), after: '{}', state: 'skipped', reason: '属性未变更' });
          continue;
        }
        file.readonly = after.readonly;
        file.hidden = after.hidden;
        ops.push({ id: it.id, kind: 'attrs', path: it.path, before: JSON.stringify(before), after: JSON.stringify(after), state: 'done' });
        applied.push({ id: it.id, path: it.path, before: JSON.stringify(before), after: JSON.stringify(after) });
      }

      const batch = {
        id: `mock-batch-${state.batches.length + 1}`,
        createdAt: now,
        finishedAt: now,
        state: failed.length ? 'partial' : 'completed',
        kind: 'attrs',
        policy: 'skip',
        roots: [],
        counts: { total: ops.length, done: applied.length, skipped: skipped.length, failed: failed.length },
        items: [],
        ops,
        createdDirs: [],
      };
      state.batches.unshift(batch);
      return { batch, applied, skipped, failed };
    },

    apply_move: (args) => {
      const spec = args.spec || {};
      const now = Date.now();
      const ops = [];
      const applied = [];
      const skipped = [];
      const failed = [];
      const created = [];
      const disk = diskKeys();
      const claimed = new Set();

      for (const it of args.items || []) {
        if (key(it.target) === key(it.source)) {
          skipped.push({ id: it.id, source: it.source, reason: '位置未变更' });
          ops.push({ id: it.id, kind: 'move', path: it.source, target: it.target, before: '{}', after: '{}', state: 'skipped', reason: '位置未变更' });
          continue;
        }
        if (disk.has(key(it.target)) || claimed.has(key(it.target))) {
          skipped.push({ id: it.id, source: it.source, reason: '目标已存在同名文件（移动不覆盖）' });
          ops.push({ id: it.id, kind: 'move', path: it.source, target: it.target, before: '{}', after: '{}', state: 'skipped', reason: '目标已存在' });
          continue;
        }
        const parent = splitPath(it.target).parent;
        if (!state.dirs.has(key(parent))) {
          state.dirs.add(key(parent));
          created.push(parent);
        }
        const index = state.files.findIndex((f) => key(f.path) === key(it.source));
        if (index < 0) {
          failed.push({ id: it.id, source: it.source, reason: '源文件不存在' });
          continue;
        }
        state.files[index].path = it.target;
        state.files[index].name = splitPath(it.target).name;
        claimed.add(key(it.target));
        const before = JSON.stringify({ path: it.source, parent: splitPath(it.source).parent });
        const after = JSON.stringify({ path: it.target, parent });
        ops.push({ id: it.id, kind: 'move', path: it.source, target: it.target, before, after, state: 'done' });
        applied.push({ id: it.id, path: it.source, target: it.target, before, after });
      }

      const batch = {
        id: `mock-batch-${state.batches.length + 1}`,
        createdAt: now,
        finishedAt: now,
        state: failed.length ? 'partial' : 'completed',
        kind: 'move',
        policy: 'skip',
        roots: spec.roots || [],
        counts: { total: ops.length, done: applied.length, skipped: skipped.length, failed: failed.length },
        items: [],
        ops,
        createdDirs: created,
      };
      state.batches.unshift(batch);
      return { batch, applied, skipped, failed };
    },

    read_metadata: (args) => {
      state.metadata.push(args.path);
      const name = splitPath(args.path).name.toLowerCase();
      const ext = name.includes('.') ? name.split('.').pop() : '';
      if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
        return {
          kind: 'image',
          format: ext === 'png' ? 'PNG 图像' : 'JPEG 图像',
          readOnly: true,
          fields: [
            { label: '尺寸', value: '4032 × 3024 px' },
            { label: '相机型号', value: 'DemoCam X100' },
            { label: '拍摄时间', value: '2025-06-18 09:12:33' },
            { label: '方向', value: '正常' },
          ],
          warnings: [],
        };
      }
      if (['mp3', 'flac'].includes(ext)) {
        return {
          kind: 'audio',
          format: 'MP3 音频',
          readOnly: true,
          fields: [
            { label: '标题', value: '夜曲' },
            { label: '艺术家', value: '周杰伦' },
            { label: '专辑', value: '十一月的萧邦' },
            { label: '年份', value: '2005' },
            { label: '采样率', value: '44.1 kHz' },
            { label: '时长', value: '2:34' },
          ],
          warnings: [],
        };
      }
      if (['docx', 'doc'].includes(ext)) {
        return {
          kind: 'document',
          format: 'Word 文档 (DOCX)',
          readOnly: true,
          fields: [
            { label: '标题', value: '会议记录（演示）' },
            { label: '作者', value: '张三' },
            { label: '主题', value: '周会' },
            { label: '创建时间', value: '2026-02-01 10:00:00' },
            { label: '页数', value: '3' },
            { label: '字数', value: '1200' },
          ],
          warnings: [],
        };
      }
      if (ext === 'pdf') {
        return {
          kind: 'document',
          format: 'PDF 文档',
          readOnly: true,
          fields: [
            { label: '标题', value: '产品说明（演示）' },
            { label: '作者', value: '李四' },
            { label: '创建工具', value: 'DemoWriter' },
            { label: '页数（粗略）', value: '12' },
          ],
          warnings: [],
        };
      }
      if (['txt', 'md', 'log', 'csv', 'json'].includes(ext)) {
        return {
          kind: 'text',
          format: '文本文件',
          readOnly: true,
          fields: [
            { label: '编码', value: 'UTF-8' },
            { label: '行数', value: '3' },
            { label: '字符数', value: '42' },
            { label: '内容摘要', value: 'E2E 文本样本' },
          ],
          warnings: [],
        };
      }
      return {
        kind: 'other',
        format: '未识别的文件类型',
        readOnly: true,
        fields: [{ label: '文件大小', value: '2.3 MB' }],
        warnings: ['该类型暂无元数据解析器；不会尝试修改文件。'],
      };
    },

    read_metadata_batch: (args) =>
      (args.paths || []).map((path) => ({
        path,
        info: handlers.read_metadata({ path }),
        error: null,
      })),

    // 事件插件：供拖放事件链路测试（不依赖真实窗口）
    'plugin:event|listen': (args) => {
      const id = (state.eventSeq += 1);
      state.eventMap.set(id, { event: args.event, handler: args.handler });
      return id;
    },
    'plugin:event|unlisten': (args) => {
      state.eventMap.delete(args.eventId);
      return null;
    },

    read_text_file: (args) => {
      if (state.writes[args.path] !== undefined) return state.writes[args.path];
      if (state.planContent !== null) return state.planContent;
      return '{}';
    },

    write_text_atomic: (args) => {
      const existed = state.writes[args.path] !== undefined;
      state.writes[args.path] = args.content;
      state.lastWritePath = args.path;
      return existed ? `C:\\Users\\E2E\\AppData\\Roaming\\app.renomio.desktop\\exports-backup\\${Date.now()}-backup` : null;
    },

    write_bytes_atomic: (args) => {
      const existed = state.binaryWrites[args.path] !== undefined;
      state.binaryWrites[args.path] = args.content;
      state.lastWritePath = args.path;
      return existed ? `C:\\Users\\E2E\\AppData\\Roaming\\app.renomio.desktop\\exports-backup\\${Date.now()}-backup` : null;
    },

    'plugin:dialog|open': (args) => {
      const opts = args.options || {};
      if (opts.directory) return 'D:\\e2e\\旅行';
      const filters = (opts.filters || []).flatMap((f) => f.extensions || []);
      if (filters.includes('json')) return 'D:\\e2e\\plans\\plan.json';
      const paths = state.files.map((f) => f.path);
      return opts.multiple ? paths : paths[0];
    },

    'plugin:dialog|save': (args) => {
      const filters = ((args.options || {}).filters || []).flatMap((f) => f.extensions || []);
      if (filters.includes('csv')) return 'D:\\e2e\\out\\list.csv';
      if (filters.includes('xlsx')) return 'D:\\e2e\\out\\report.xlsx';
      if (filters.includes('html')) return 'D:\\e2e\\out\\report.html';
      if (filters.includes('tsv')) return 'D:\\e2e\\out\\report.tsv';
      return 'D:\\e2e\\out\\plan.json';
    },

    append_log: () => null,
    reveal_path: () => null,
    startup_report: (args) => {
      state.startupReports = state.startupReports || [];
      state.startupReports.push(args);
      return null;
    },
    cancel_apply: () => false,

    // 窗口控制：模拟 Tauri window 插件命令，供 E2E 断言关闭/最小化/最大化按钮确实调用了 API
    'plugin:window|close': () => {
      state.windowCalls.push('close');
      return null;
    },
    'plugin:window|minimize': () => {
      state.windowCalls.push('minimize');
      return null;
    },
    'plugin:window|toggle_maximize': () => {
      state.windowCalls.push('toggle_maximize');
      return null;
    },
    'plugin:window|start_dragging': () => {
      state.windowCalls.push('start_dragging');
      return null;
    },
    find_duplicates: (args) => {
      const paths = args.paths || [];
      const bySize = new Map();
      for (const p of paths) {
        const f = state.files.find((x) => key(x.path) === key(p));
        if (!f || f.isDir) continue;
        const list = bySize.get(f.content ? `c:${f.content}` : `s:${f.size}`) ?? [];
        list.push(p);
        bySize.set(f.content ? `c:${f.content}` : `s:${f.size}`, list);
      }
      const groups = [...bySize.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([gkey, list]) => ({
          size: state.files.find((x) => key(x.path) === key(list[0]))?.size ?? 0,
          hash: `mock-${gkey}`,
          paths: [...list].sort(),
        }));
      return { groups, scanned: paths.length, warnings: [] };
    },
    meta_capabilities: () => [
      { kind: 'image', format: 'JPEG', read: true, write: true, fields: [], notes: 'XMP + EXIF 文本标签' },
      { kind: 'image', format: 'PNG', read: true, write: true, fields: [], notes: 'iTXt XMP' },
      { kind: 'image', format: 'WebP', read: true, write: true, fields: [], notes: 'VP8X XMP' },
      { kind: 'image', format: 'TIFF', read: true, write: true, fields: [], notes: 'IFD0 + XMP' },
      { kind: 'image', format: 'HEIC', read: false, write: false, fields: [], notes: '本版本明确不支持' },
      { kind: 'audio', format: 'MP3', read: true, write: true, fields: [], notes: 'ID3v2.3/2.4' },
      { kind: 'audio', format: 'FLAC', read: true, write: true, fields: [], notes: 'Vorbis comment' },
      { kind: 'audio', format: 'M4A', read: true, write: true, fields: [], notes: 'iTunes atoms' },
      { kind: 'audio', format: 'OGG', read: true, write: true, fields: [], notes: 'Vorbis/Opus' },
      { kind: 'audio', format: 'WMA', read: false, write: false, fields: [], notes: '本版本不支持' },
      { kind: 'document', format: 'DOCX', read: true, write: true, fields: [], notes: 'core.xml' },
      { kind: 'document', format: 'PDF', read: true, write: true, fields: [], notes: 'Info + XMP' },
    ],
    meta_read: (args) => metaSnapshotOf(args.path),
    meta_edit: (args) => (args.items || []).map((item) => {
      const snap = metaSnapshotOf(item.path);
      const started = Date.now();
      if (!snap.writable) {
        return {
          path: item.path, kind: snap.kind, format: snap.format, supported: false, ok: false,
          backup: null, written: [], cleared: [], ignored: [], verified: false,
          error: `${snap.format} 不支持写入：${snap.unsupportedReason}`, warnings: [],
          elapsedMs: Date.now() - started,
        };
      }
      const bad = Object.keys(item.fields || {}).find((id) => !snap.supportedFields.includes(id));
      if (bad) {
        return {
          path: item.path, kind: snap.kind, format: snap.format, supported: true, ok: false,
          backup: null, written: [], cleared: [], ignored: [], verified: false,
          error: `字段 ${bad} 不适用于 ${snap.format}`, warnings: [], elapsedMs: Date.now() - started,
        };
      }
      state.meta = state.meta || {};
      const current = { ...(state.meta[item.path] || snap.fields) };
      const written = [];
      const cleared = [];
      for (const [id, value] of Object.entries(item.fields || {})) {
        if (value === '') {
          delete current[id];
          cleared.push(id);
        } else {
          current[id] = value;
          written.push(id);
        }
      }
      state.meta[item.path] = current;
      return {
        path: item.path, kind: snap.kind, format: snap.format, supported: true, ok: true,
        backup: `${item.path}.${Date.now()}.bak`, written, cleared, ignored: [], verified: true,
        error: null, warnings: [], elapsedMs: Date.now() - started,
      };
    }),
    meta_restore_backup: () => 'restored',
    check_update: () => {
      const mode = state.updateMode || 'latest';
      if (mode === 'error') throw new Error('mock 网络不可用');
      const available = mode === 'available';
      return {
        available,
        currentVersion: '1.0.0-alpha8',
        version: available ? '1.0.0-alpha9' : '1.0.0-alpha8',
        notes: available ? 'alpha9：单栏规则链与冲突提示' : '',
        pubDate: '2026-11-06T00:00:00Z',
        source: 'GitHub',
        installable: true,
        assetName: 'Renomio_1.0.0-alpha9_x64-setup.exe',
        assetSize: available ? 12345678 : null,
      };
    },
    download_update: (args) => {
      state.lastDownloadMode = args.mode;
      state.lastDownloadMirror = args.mirror;
      return {
        path: 'C:\\Users\\E2E\\Downloads\\Renomio_1.0.0-alpha9_x64-setup.exe',
        version: '1.0.0-alpha9',
        source: 'GitHub',
        size: 12345678,
      };
    },
    install_saved_update: (args) => {
      state.installSavedPath = args.path;
      return null;
    },
    open_homepage: () => {
      state.homepageOpened = (state.homepageOpened || 0) + 1;
      return null;
    },
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => undefined,
  };

  let callbackSeq = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
    transformCallback: (callback, once) => {
      callbackSeq += 1;
      const id = callbackSeq;
      const name = `_${id}`;
      window[name] = (payload) => {
        if (once) delete window[name];
        callback(payload);
      };
      return id;
    },
    invoke: async (cmd, args) => {
      record(cmd, args);
      const handler = handlers[cmd];
      if (!handler) throw new Error(`mock 未实现命令：${cmd}`);
      return await handler(args || {});
    },
  };
})();
