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
    --accent: #2563eb;
    --accent-soft: #eff6ff;
    --text: #1f2937;
    --text-secondary: #6b7280;
    --border: #e5e7eb;
    --bg: #f9fafb;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
    color: var(--text);
    background: var(--bg);
    line-height: 1.75;
    padding: 48px 20px 80px;
  }
  .page {
    max-width: 820px;
    margin: 0 auto;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
    padding: 56px 64px;
  }
  .report-header {
    border-bottom: 2px solid var(--accent);
    padding-bottom: 20px;
    margin-bottom: 32px;
  }
  .report-header h1.doc-title {
    font-size: 26px;
    font-weight: 700;
    color: var(--text);
    letter-spacing: 0.5px;
    border: none;
    padding: 0;
    margin: 0 0 8px;
  }
  .report-meta {
    font-size: 13px;
    color: var(--text-secondary);
  }
  .report-body h2 {
    font-size: 19px;
    font-weight: 700;
    color: var(--accent);
    margin: 32px 0 14px;
    padding-left: 12px;
    border-left: 4px solid var(--accent);
    line-height: 1.4;
  }
  .report-body h3 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
    margin: 22px 0 10px;
  }
  .report-body p { margin: 10px 0; font-size: 15px; }
  .report-body ul, .report-body ol { margin: 10px 0 10px 4px; padding-left: 22px; }
  .report-body li { margin: 6px 0; font-size: 15px; }
  .report-body li::marker { color: var(--accent); }
  .report-body strong { color: #111827; font-weight: 600; }
  .report-body blockquote {
    border-left: 3px solid var(--border);
    padding: 4px 16px;
    margin: 14px 0;
    color: var(--text-secondary);
    background: var(--accent-soft);
    border-radius: 0 8px 8px 0;
  }
  .report-body code {
    font-family: "SF Mono", Consolas, monospace;
    font-size: 13px;
    background: #f3f4f6;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .report-body table {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0;
    font-size: 14px;
  }
  .report-body th, .report-body td {
    border: 1px solid var(--border);
    padding: 8px 12px;
    text-align: left;
  }
  .report-body th { background: var(--accent-soft); font-weight: 600; }
  .report-body hr { border: none; border-top: 1px solid var(--border); margin: 28px 0; }
  .report-footer {
    margin-top: 40px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-secondary);
    text-align: center;
  }
  @media print {
    body { background: #fff; padding: 0; }
    .page { border: none; box-shadow: none; padding: 24px; max-width: 100%; }
  }
  @media (max-width: 640px) {
    .page { padding: 32px 24px; }
  }
</style>
</head>
<body>
  <div class="page">
    <header class="report-header">
      <h1 class="doc-title">${safeTitle}</h1>
      <div class="report-meta">生成时间：${generatedAt} · 由 Hermes Studio 会议 AI 自动生成</div>
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
