// 批量迁移的公共辅助：结果类型、目标盘可用空间、确认文案。
//
// 应用管理与数据迁移的批量流程几乎一致，确认框要展示的信息也相同，
// 集中在这里可以避免两边文案与判定各自漂移。

import { invoke } from '@tauri-apps/api/core';
import type { DiskUsage } from '../types';

/** 批量结果里单个条目的结局 */
export type BatchItemStatus = 'success' | 'failed' | 'skipped';

export interface BatchReportItem {
  name: string;
  status: BatchItemStatus;
  /** 失败原因或被跳过的理由；成功时为空 */
  reason?: string;
}

/**
 * 目标路径所在盘的可用空间。
 *
 * get_disk_usage 的 mount_point 形如 "D:\"，用盘符前缀匹配即可。
 * 网络路径、未挂载卷或取盘信息失败时返回 null —— 调用处应省略空间提示，而不是中断流程。
 */
export async function getAvailableSpaceForPath(path: string): Promise<number | null> {
  const drive = path.slice(0, 2).toUpperCase();
  if (!/^[A-Z]:$/.test(drive)) return null;
  try {
    const disks = await invoke<DiskUsage[]>('get_disk_usage');
    return disks.find((disk) => disk.mount_point.toUpperCase().startsWith(drive))?.free_space ?? null;
  } catch {
    return null;
  }
}

/** 汇总体积文案；无效或为 0 时返回 null，调用处改用「体积未知」 */
export function formatTotalBytes(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${parseFloat((bytes / Math.pow(1024, unitIndex)).toFixed(2))} ${units[unitIndex]}`;
}

interface BatchConfirmParams {
  /** 量词，如「个应用」「个文件夹」 */
  noun: string;
  count: number;
  targetDir: string;
  /** 选中项体积之和；未知时传 0 */
  totalBytes: number;
  freeBytes: number | null;
  /** 位于高风险目录、批量时会被跳过的条数 */
  riskyCount: number;
  /** 额外风险说明（例如数据迁移选中了系统文件夹） */
  extraWarning?: string;
}

/**
 * 批量迁移确认文案。
 *
 * 目的是让用户点「开始迁移」之前就知道：要搬多少、目标盘够不够、
 * 有多少项会因为高风险被跳过 —— 这些信息缺失时，用户只能在中途看到零星失败。
 */
export function buildBatchConfirmMessage(params: BatchConfirmParams): string {
  const { noun, count, targetDir, totalBytes, freeBytes, riskyCount, extraWarning } = params;
  const lines = [`即将批量迁移 ${count} ${noun}到：`, targetDir, ''];

  const totalText = formatTotalBytes(totalBytes);
  const freeText = freeBytes === null ? null : formatTotalBytes(freeBytes);
  if (totalText && freeText) {
    lines.push(`共 ${totalText} · 目标盘剩余 ${freeText}`);
    // 空间不足时提前说清楚：否则用户只会在中途看到某一个项目失败
    if (freeBytes !== null && freeBytes < totalBytes) {
      lines.push('⚠ 目标盘剩余空间不足，放不下的项目会迁移失败');
    }
  } else if (totalText) {
    lines.push(`共 ${totalText}`);
  } else {
    lines.push('体积未知（尚未扫描大小）');
  }

  if (riskyCount > 0) {
    lines.push(`其中 ${riskyCount} 个位于高风险目录，批量迁移会跳过它们`);
  }
  if (extraWarning) lines.push('', extraWarning);
  lines.push('', '是否继续？');
  return lines.join('\n');
}
