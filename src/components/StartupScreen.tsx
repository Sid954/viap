import { ShieldCheck } from 'lucide-react';

/**
 * 启动页只负责展示启动状态，不阻塞后台数据预热，避免机械硬盘扫描时出现空白窗口。
 */
export default function StartupScreen() {
  return (
    <div
      // 层级必须高于所有界面元素：液态玻璃下标题栏被提到 1300（见 glass.css），弹窗是 1400。
      // 启动页只用 z-100 时，玻璃模式下整条标题栏会露在启动页之外（普通模式不会，因为标题栏
      // 那时是 z-index:auto）。启动页是开机遮罩，理应盖住一切，所以固定在最上层。
      className="startup-screen fixed inset-0 z-[1500] flex items-center justify-center overflow-hidden"
      // 必须走独立 token：液态玻璃外观下 --bg-app 被设为 transparent（让内容区露出背景光斑），
      // 启动页跟着用就会整层透明，直接看到底下已经渲染好的界面。
      // 用 backgroundColor 而不是 background 简写 —— 简写会连带把 background-image 重置为 none，
      // 那样玻璃外观下 body 那层光斑（复用自同一条 CSS 规则）就透不过来了。
      style={{ backgroundColor: 'var(--bg-startup)', color: 'var(--text-primary)' }}
      role="status"
      aria-label="Viap 正在启动"
    >
      <div className="startup-glow" aria-hidden="true" />
      <div className="relative flex flex-col items-center">
        <div className="startup-logo-wrap flex items-center justify-center">
          <img
            src="/icon.svg"
            alt="Viap"
            className="h-16 w-16 rounded-2xl"
            style={{ boxShadow: '0 12px 30px color-mix(in srgb, var(--color-primary) 28%, transparent)' }}
          />
        </div>
        <div className="mt-5 text-xl font-semibold tracking-wide">Viap</div>
        <div className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          正在准备应用管理
        </div>
        <div className="startup-progress mt-7" aria-hidden="true">
          <span />
        </div>
        <div className="mt-4 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>正在加载本地缓存与磁盘信息</span>
        </div>
      </div>
    </div>
  );
}
