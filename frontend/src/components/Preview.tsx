import { useMemo } from "react";
import type { Artifact } from "../types";

/**
 * 把工件中的 index.html 变成可独立运行的 srcDoc：
 * 将 <link href="style.css"> 与 <script src="main.js"> 的相对引用内联为
 * <style> / <script> 块。仅处理平铺结构的项目文件（与 Agent 的产出约束一致）。
 */
export function buildSrcDoc(files: Record<string, { content: string }>): string | null {
  const index = files["index.html"];
  if (!index) return null;
  let html = index.content;

  html = html.replace(/<link[^>]*href=["']([^"']+)["'][^>]*>/gi, (m, href: string) => {
    const f = files[href];
    return f && href.toLowerCase().endsWith(".css") ? `<style>\n${f.content}\n</style>` : m;
  });

  html = html.replace(
    /<script[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (m, src: string) => {
      const f = files[src];
      return f && src.toLowerCase().endsWith(".js")
        ? `<script>\n${f.content.replace(/<\/script/gi, "<\\/script")}\n</script>`
        : m;
    }
  );

  return html;
}

export default function Preview({ artifact }: { artifact: Artifact }) {
  const srcDoc = useMemo(() => buildSrcDoc(artifact.files), [artifact]);

  if (!srcDoc) {
    return (
      <div className="empty">
        <div>🖥 实时预览</div>
        <div>发送需求后，Agent 会生成含 index.html 的自包含项目，这里将实时渲染效果。</div>
      </div>
    );
  }
  // sandbox：允许脚本与弹窗，禁止 same-origin / 顶层导航 / 表单提交，隔离生成代码
  return <iframe title="preview" className="preview-frame" sandbox="allow-scripts allow-modals" srcDoc={srcDoc} />;
}
