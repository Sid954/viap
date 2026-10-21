// 自动更新提示 — 统一弹窗
//
// 应用启动后静默检测更新：非便携版走插件在线更新，便携版只做版本比对后引导手动下载。
// 「发现新版本」「下载中」「安装中」共用同一个 Modal，只切换内容，不再占用首页顶部的版面。
// 复用 Modal 外壳意味着底色、投影、描边都走语义 token，液态玻璃外观下自动生效。
// 自动检测失败保持静默，不打扰用户。

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ArrowDownToLine, ArrowRight, HardDriveDownload, Loader2, X } from 'lucide-react';
import Modal from './Modal';
import { PORTABLE_CLOUD_UPDATE_URL, PORTABLE_UPDATE_URL, useUpdater } from '../hooks/useUpdater';

/** 弹窗当前展示的形态 */
type UpdateView = 'portable' | 'available' | 'downloading' | 'installing';

/**
 * 关闭时底层状态会被 dismiss 清空，但弹窗还要播 180ms 淡出动画。
 * 记住最后一次展示的内容，避免淡出过程中正文变空、面板高度塌陷。
 */
interface ShownContent {
  view: UpdateView;
  version: string;
  notes: string;
  progress: number;
}

const FOOTER_STYLE: CSSProperties = {
  borderTop: '1px solid var(--border-color)',
  background: 'var(--bg-modal-footer)',
};

/** 弹窗标题栏：图标 + 标题；下载/安装中不提供关闭入口，避免误取消 */
function UpdateHeader({ icon, title, onClose }: { icon: ReactNode; title: string; onClose?: () => void }) {
  return (
    <div
      className="flex items-center gap-2.5 flex-shrink-0 px-5 py-3"
      style={{ borderBottom: '1px solid var(--border-color)' }}
    >
      <div
        className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0"
        style={{ background: 'var(--color-primary-light)' }}
      >
        {icon}
      </div>
      <h2 className="flex-1 min-w-0 text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h2>
      {onClose && (
        <button onClick={onClose} className="btn btn-ghost btn-icon w-7 h-7" aria-label="关闭">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

/** 更新说明通常是整段 CHANGELOG，限高滚动，避免把弹窗撑到屏幕外。
 *  底色用 --bg-inset 而不是 --bg-panel-block：后者在普通模式下等于 --bg-row，
 *  与弹窗面板同色、整块会看不见；--bg-inset 在两种外观下都有可辨的层次。 */
function ReleaseNotes({ notes }: { notes: string }) {
  if (!notes.trim()) return null;
  return (
    <div
      className="rounded-lg px-3 py-2.5 text-[12px] leading-relaxed whitespace-pre-wrap overflow-y-auto"
      style={{ background: 'var(--bg-inset)', color: 'var(--text-secondary)', maxHeight: 240 }}
    >
      {notes}
    </div>
  );
}

/** 下载进度：未拿到 Content-Length 时停留在 5% 初始态，避免看起来卡死在 0 */
function DownloadProgress({ percent }: { percent: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[12px]">
        <span style={{ color: 'var(--text-secondary)' }}>正在下载更新</span>
        <span className="tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{percent}%</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-inset)' }}>
        <div
          className="h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${Math.max(percent, 5)}%`, background: 'var(--color-primary)' }}
        />
      </div>
    </div>
  );
}

export default function UpdateNotification() {
  const {
    status, updateInfo, downloadProgress,
    isPortable, portableUpdate, checkForUpdate, downloadAndInstall, dismiss,
  } = useUpdater();
  const [portableNoticeVisible, setPortableNoticeVisible] = useState(true);
  const [currentVersion, setCurrentVersion] = useState('');

  // 发行模式确认后重置提示状态，避免切换开发/生产环境时沿用旧的隐藏状态。
  useEffect(() => {
    if (isPortable !== true) setPortableNoticeVisible(true);
  }, [isPortable]);

  // 当前版本只用于「旧 → 新」对比，取不到时显示占位符，不影响更新流程
  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => setCurrentVersion(''));
  }, []);

  // 启动后延迟检测更新，避免影响首屏性能
  useEffect(() => {
    if (isPortable !== false) return;
    const timer = setTimeout(() => {
      checkForUpdate();
    }, 3000);
    return () => clearTimeout(timer);
  }, [checkForUpdate, isPortable]);

  // 只有后端确认线上版本确实更高时才提示：版本相同或无法确认时保持静默，
  // 避免拿着最新包的用户每次启动都被提示"发现新版本"。
  const portableLatest = isPortable === true && portableUpdate?.has_update === true
    ? portableUpdate.latest_version
    : null;

  let view: UpdateView | null = null;
  if (isPortable === true) {
    if (portableLatest && portableNoticeVisible) view = 'portable';
  } else if (status === 'available') {
    view = 'available';
  } else if (status === 'downloading') {
    view = 'downloading';
  } else if (status === 'installing') {
    view = 'installing';
  }

  const shown = useRef<ShownContent>({ view: 'available', version: '', notes: '', progress: 0 });
  if (view) {
    shown.current = {
      view,
      version: updateInfo?.version ?? '',
      notes: updateInfo?.notes ?? '',
      progress: downloadProgress,
    };
  }
  const content = shown.current;

  const isPortableView = content.view === 'portable';
  const isAvailable = content.view === 'available';
  const isDownloading = content.view === 'downloading';

  // 便携版的「关闭」只是隐藏提示，其余形态要复位更新状态机
  const closePortable = () => setPortableNoticeVisible(false);
  const handleClose = isPortableView ? closePortable : dismiss;

  const header = (
    <UpdateHeader
      title={isAvailable || isPortableView ? '发现新版本' : isDownloading ? '正在下载更新' : '正在安装更新'}
      icon={
        isPortableView ? <HardDriveDownload className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
          : isAvailable ? <ArrowDownToLine className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
            : <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-primary)' }} />
      }
      onClose={isAvailable || isPortableView ? handleClose : undefined}
    />
  );

  const body = isPortableView ? (
    <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
      便携版不提供自动更新。请手动下载 v{portableLatest} 覆盖当前程序，数据目录会保留。
    </p>
  ) : isAvailable ? (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 text-[12px]">
        <span style={{ color: 'var(--text-secondary)' }}>当前版本</span>
        <span className="tabular-nums" style={{ color: 'var(--text-tertiary)' }}>v{currentVersion || '—'}</span>
        <ArrowRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
        <span className="text-[13px] font-semibold tabular-nums" style={{ color: 'var(--color-primary)' }}>
          v{content.version}
        </span>
      </div>
      <ReleaseNotes notes={content.notes} />
    </div>
  ) : isDownloading ? (
    <DownloadProgress percent={content.progress} />
  ) : (
    <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
      <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-success)' }} />
      正在安装，完成后将自动重启…
    </div>
  );

  const footer = (
    <div className="flex items-center justify-end gap-2 px-5 py-3" style={FOOTER_STYLE}>
      {isPortableView ? (
        <>
          <button onClick={closePortable} className="btn h-7 text-[11px]">稍后</button>
          <button
            onClick={() => { openUrl(PORTABLE_CLOUD_UPDATE_URL).catch(() => undefined); }}
            className="btn h-7 text-[11px]"
          >
            网盘下载
          </button>
          <button
            onClick={() => { openUrl(PORTABLE_UPDATE_URL).catch(() => undefined); }}
            className="btn btn-primary h-7 text-[11px]"
          >
            GitHub 下载
          </button>
        </>
      ) : isAvailable ? (
        <>
          <button onClick={dismiss} className="btn h-7 text-[11px]">稍后再说</button>
          <button onClick={() => { downloadAndInstall(); }} className="btn btn-primary h-7 text-[11px]">
            立即更新
          </button>
        </>
      ) : isDownloading ? (
        <button onClick={dismiss} className="btn h-7 text-[11px]">取消下载</button>
      ) : (
        // relaunch 失败时的兜底关闭入口
        <button onClick={dismiss} className="btn h-7 text-[11px]">关闭</button>
      )}
    </div>
  );

  return (
    <Modal
      isOpen={view !== null}
      onClose={handleClose}
      // 下载/安装中不允许点遮罩或 Esc 关闭，避免误取消
      closeOnOverlay={isAvailable || isPortableView}
      width={460}
      bodyClassName="px-5 py-4"
      header={header}
      footer={footer}
    >
      {body}
    </Modal>
  );
}
