import MarkdownIt from 'markdown-it'

/**
 * 将会议报告 Markdown 转换为精简美观、可独立打开的 HTML 页面。
 * 所有样式内嵌，无外部依赖，可直接下载离线查看或打印。
 */
export function buildReportHtml(markdown: string, title: string): string {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
  const body = md.render(markdown || '')

  const generatedAt = new Date().toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  const safeTitle = escapeHtml(title || '会议报告')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<style>
  :root {
    --primary: #4f46e5;
    --gradient: linear-gradient(135deg, #6366f1 0%, #3b82f6 55%, #06b6d4 100%);
    --text: #1e293b;
    --text-secondary: #64748b;
    --text-light: #94a3b8;
    --border: #e2e8f0;
    --bg-soft: #f8fafc;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
    color: var(--text);
    background: linear-gradient(180deg, #eef2f7 0%, #e8edf5 100%);
    line-height: 1.8;
    padding: 48px 20px 72px;
  }
  .page {
    max-width: 840px;
    margin: 0 auto;
    background: #fff;
    border-radius: 20px;
    box-shadow: 0 10px 48px rgba(30, 41, 59, 0.12);
    overflow: hidden;
  }
  .gradient-bar { height: 6px; background: var(--gradient); }

  /* 头部 */
  .report-header {
    padding: 44px 64px 26px;
    background: linear-gradient(180deg, var(--bg-soft) 0%, #ffffff 100%);
    border-bottom: 1px solid var(--border);
  }
  .doc-title {
    font-size: 30px;
    font-weight: 800;
    letter-spacing: 0.3px;
    line-height: 1.35;
    background: var(--gradient);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: var(--primary);
  }
  .report-meta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 16px;
    padding: 6px 14px;
    background: var(--bg-soft);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 12.5px;
    color: var(--text-secondary);
  }

  /* 正文 */
  .report-body {
    padding: 36px 64px 8px;
    counter-reset: section;
  }
  .report-body h2 {
    counter-increment: section;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 19px;
    font-weight: 700;
    color: var(--text);
    margin: 38px 0 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .report-body h2::before {
    content: counter(section, decimal-leading-zero);
    flex-shrink: 0;
    min-width: 34px;
    padding: 3px 0;
    text-align: center;
    font-size: 13px;
    font-weight: 700;
    color: #fff;
    background: var(--gradient);
    border-radius: 8px;
    letter-spacing: 0.5px;
  }
  .report-body h2:first-child { margin-top: 4px; }
  .report-body h3 {
    font-size: 16px;
    font-weight: 600;
    color: var(--primary);
    margin: 24px 0 10px;
  }
  .report-body p { margin: 12px 0; font-size: 15px; }
  .report-body ul, .report-body ol { margin: 12px 0; padding-left: 6px; list-style-position: outside; }
  .report-body li { margin: 9px 0 9px 20px; font-size: 15px; line-height: 1.75; }
  .report-body li::marker { color: var(--primary); font-weight: 600; }
  .report-body strong { color: #0f172a; font-weight: 650; }
  .report-body em { color: var(--text-secondary); }
  .report-body blockquote {
    margin: 16px 0;
    padding: 12px 18px;
    border-left: 4px solid var(--primary);
    background: var(--bg-soft);
    border-radius: 0 10px 10px 0;
    color: var(--text-secondary);
  }
  .report-body blockquote p { margin: 4px 0; }
  .report-body code {
    font-family: "SF Mono", Consolas, monospace;
    font-size: 13px;
    background: #f1f5f9;
    padding: 2px 7px;
    border-radius: 5px;
    color: #be185d;
  }
  .report-body table {
    width: 100%;
    border-collapse: collapse;
    margin: 18px 0;
    font-size: 14px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .report-body th, .report-body td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); }
  .report-body th { background: var(--bg-soft); font-weight: 650; color: var(--text); }
  .report-body tr:last-child td { border-bottom: none; }
  .report-body hr { border: none; height: 1px; background: var(--border); margin: 32px 0; }

  /* 页脚 */
  .report-footer {
    margin-top: 36px;
    padding: 18px 64px 30px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-light);
    text-align: center;
    background: var(--bg-soft);
  }

  @media print {
    body { background: #fff; padding: 0; }
    .page { box-shadow: none; border-radius: 0; max-width: 100%; }
    .report-header, .report-body { padding-left: 24px; padding-right: 24px; }
    .report-footer { padding-left: 24px; padding-right: 24px; }
  }
  @media (max-width: 640px) {
    .report-header { padding: 32px 24px 20px; }
    .report-body { padding: 28px 24px 4px; }
    .report-footer { padding: 16px 24px 24px; }
    .doc-title { font-size: 24px; }
  }
</style>
</head>
<body>
  <div class="page">
    <div class="gradient-bar"></div>
    <header class="report-header">
      <h1 class="doc-title">${safeTitle}</h1>
      <div class="report-meta">生成时间：${generatedAt} · Hermes Studio 会议 AI 自动生成</div>
    </header>
    <main class="report-body">
${body}
    </main>
    <footer class="report-footer">本报告由 AI 基于会议转写内容自动生成，仅供参考</footer>
  </div>
</body>
</html>`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
