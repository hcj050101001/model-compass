"use client";

import katex from "katex";
import { useMemo } from "react";

interface LatexFormulaProps {
  tex: string;
  displayMode?: boolean;
  className?: string;
}

/**
 * Renders deterministic LaTeX formulas via KaTeX without runtime DOM mutation.
 */
export function LatexFormula({
  tex,
  displayMode = false,
  className = "",
}: LatexFormulaProps) {
  const html = useMemo(
    () =>
      katex.renderToString(tex, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
      }),
    [tex, displayMode]
  );

  if (displayMode) {
    return (
      <div
        className={`overflow-x-auto py-1 text-text-primary ${className}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <span
      className={`inline-block align-middle ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
