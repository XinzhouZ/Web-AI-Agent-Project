import { useEffect, useRef } from "react";
import { Highlight, themes } from "prism-react-renderer";
import { THEMES, type ThemeId } from "../theme";

/** 后端 language → Prism 语言标识 */
const PRISM_LANG: Record<string, string> = {
  markup: "markup",
  css: "css",
  javascript: "javascript",
  jsx: "jsx",
  typescript: "tsx",
  tsx: "tsx",
  json: "json",
  python: "python",
  markdown: "markdown",
  yaml: "yaml",
  bash: "bash",
  sql: "sql",
  text: "markup",
};

export default function CodeView({
  code,
  language,
  theme = "dark",
}: {
  code: string;
  language: string;
  theme?: ThemeId;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 切换文件 / 代码更新时回到顶部，避免沿用上一个文件的滚动偏移
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [code]);

  return (
    <div className="code-scroll" ref={scrollRef}>
      <Highlight
        theme={THEMES.find((t) => t.id === theme)?.dark === false ? themes.nightOwlLight : themes.nightOwl}
        code={code}
        language={PRISM_LANG[language] ?? "markup"}
      >
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre className={className} style={{ ...style, backgroundColor: "transparent" }}>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                <span style={{ opacity: 0.35, marginRight: 14, userSelect: "none" }}>{i + 1}</span>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
