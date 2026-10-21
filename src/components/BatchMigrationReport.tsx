// 批量迁移结果清单
//
// 批量过程中不能用 toast 报错：toast 只有一个槽位，连续失败会互相覆盖，
// 最后只剩一个 4 秒就消失的汇总 —— 用户既不知道失败了几个，也不知道原因，
// 自然不敢再点第二次。这里把逐项结果一次性列出，失败项排在最前面。

import Modal from './Modal';
import type { BatchItemStatus, BatchReportItem } from '../utils/batchMigration';

const STATUS_META: Record<BatchItemStatus, { label: string; color: string; background: string }> = {
  success: { label: '成功', color: 'var(--color-success)', background: 'var(--color-success-light)' },
  failed: { label: '失败', color: 'var(--color-danger)', background: 'var(--color-danger-light)' },
  skipped: { label: '跳过', color: 'var(--text-tertiary)', background: 'var(--bg-row-hover)' },
};

/** 失败原因常常是后端的多行长文案，列表里只留开头，完整内容放进 title 供悬停查看 */
const REASON_PREVIEW_LIMIT = 140;

interface BatchMigrationReportProps {
  isOpen: boolean;
  onClose: () => void;
  /** 模块名，用于标题，如「应用迁移」 */
  title: string;
  items: BatchReportItem[];
  /** 用户中途停止时为 true，措辞上要和「跑完但有失败」区分开 */
  cancelled: boolean;
}

export default function BatchMigrationReport({
  isOpen, onClose, title, items, cancelled,
}: BatchMigrationReportProps) {
  const successCount = items.filter((item) => item.status === 'success').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const skippedCount = items.filter((item) => item.status === 'skipped').length;

  // 失败 → 跳过 → 成功：用户最需要重试的排在最上面
  const ordered = [
    ...items.filter((item) => item.status === 'failed'),
    ...items.filter((item) => item.status === 'skipped'),
    ...items.filter((item) => item.status === 'success'),
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`${title}结果`}
      width={520}
      footer={(
        <div
          className="flex items-center justify-end gap-2 px-5 py-3"
          style={{ borderTop: '1px solid var(--border-color)', background: 'var(--bg-modal-footer)' }}
        >
          <button onClick={onClose} className="btn btn-primary btn-sm">知道了</button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3 text-[12px]">
        {/* 先给结论，再列明细 */}
        <div className="flex items-center gap-4 flex-wrap">
          <span style={{ color: 'var(--color-success)' }}>成功 {successCount}</span>
          {failedCount > 0 && <span style={{ color: 'var(--color-danger)' }}>失败 {failedCount}</span>}
          {skippedCount > 0 && <span style={{ color: 'var(--text-tertiary)' }}>跳过 {skippedCount}</span>}
          {cancelled && <span style={{ color: 'var(--text-tertiary)' }}>· 已手动停止</span>}
        </div>

        <div className="flex flex-col max-h-[320px] overflow-y-auto">
          {ordered.map((item, index) => {
            const meta = STATUS_META[item.status];
            const reason = item.reason && item.reason.length > REASON_PREVIEW_LIMIT
              ? `${item.reason.slice(0, REASON_PREVIEW_LIMIT)}…`
              : item.reason;
            return (
              <div
                key={`${item.name}-${index}`}
                className="flex items-start gap-2 py-1.5"
                style={{ borderBottom: '1px solid var(--border-color)' }}
              >
                <span
                  className="badge flex-shrink-0"
                  style={{ color: meta.color, background: meta.background }}
                >
                  {meta.label}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate" style={{ color: 'var(--text-primary)' }} title={item.name}>
                    {item.name}
                  </p>
                  {reason && (
                    <p
                      className="mt-0.5 whitespace-pre-wrap break-all"
                      style={{ color: 'var(--text-tertiary)' }}
                      title={item.reason}
                    >
                      {reason}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
