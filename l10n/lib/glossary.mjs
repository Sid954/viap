// Starter glossary — plan §7. Extend from the corpus after Phase 1 (the
// 100 most frequent 2–4 char terms go to review-needed for approval first).
// `en` holds accepted options; validation passes when the translation
// contains at least one (case-insensitive).

export const GLOSSARY = [
  { zh: '迁移', en: ['migrate', 'migration', 'migrating'] },
  { zh: '还原', en: ['restore', 'restored', 'restoring'] },
  { zh: '恢复', en: ['restore', 'restored', 'restoring'] },
  { zh: '目录联接', en: ['directory junction'] },
  { zh: '符号链接', en: ['symbolic link'] },
  { zh: '残留', en: ['leftovers', 'leftover'] },
  { zh: '卸载', en: ['uninstall'] },
  { zh: '应用数据', en: ['app data'] },
  { zh: '大文件夹', en: ['large folders'] },
  { zh: '校验', en: ['verify', 'verification', 'validation'] },
  { zh: '回收站', en: ['Recycle Bin'] },
  { zh: '便携版', en: ['portable edition'] },
  { zh: '管理员权限', en: ['administrator privileges'] },
  { zh: '完整性校验', en: ['integrity check', 'integrity verification'] },
  { zh: '快照', en: ['snapshot'] },
  { zh: '镜像', en: ['mirror'] },
  { zh: '文件锁', en: ['file lock', 'in use'] },
  { zh: '占用', en: ['in use', 'in-use', 'file lock', 'taking up'] },
  { zh: '进程', en: ['process'] },
  { zh: '服务', en: ['service'] },
  { zh: '驱动', en: ['driver'] },
  { zh: '计划任务', en: ['scheduled task'] },
  { zh: '冷启动', en: ['cold start'] },
  { zh: '微信', en: ['WeChat'] },
  { zh: '企业微信', en: ['WeCom'] },
  { zh: '钉钉', en: ['DingTalk'] },
  { zh: '飞书', en: ['Feishu', 'Lark'] },
  { zh: '腾讯元宝', en: ['Tencent Yuanbao'] },
];

/** longest zh first — order matters for prompt display and mock replacement */
export function glossarySorted() {
  return [...GLOSSARY].sort((a, b) => b.zh.length - a.zh.length);
}

/** glossary entries whose zh appears in the source (longest match first) */
export function glossaryFor(source) {
  return glossarySorted().filter((g) => source.includes(g.zh));
}
