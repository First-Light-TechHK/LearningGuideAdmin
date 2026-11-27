import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { latexToMarkdown } from './latex-to-markdown';

describe('latexToMarkdown', () => {
  it('converts a styled Lesson 3 heading and keeps math inside its description', () => {
    const source = String.raw`{\Large\bfseries\color{primary} Lesson 3: Formula \& Notation\par}
{\normalsize\color{muted} Summary\par}
{\color{primary}\hrule height 1pt}
\textbf{\small\color{primary} BALANCE EQUATION}
{\small\color{muted} Rate $\dfrac{dT}{dt}$.}`;
    expect(latexToMarkdown(source)).toBe(
      '# Lesson 3: Formula & Notation\n\nSummary\n\n---\n\n**BALANCE EQUATION**\n\nRate $\\dfrac{dT}{dt}$.',
    );
  });

  it('converts tabularx column declarations and booktabs without losing notation', () => {
    const source = String.raw`\noindent\begin{tabularx}{\textwidth}{@{}>{\raggedright\arraybackslash}p{3.4cm} X@{}}
\toprule
\textbf{Symbol} & \textbf{Meaning \& Usage} \\
\midrule
$P_{i-1}$ & Previous population. \\[6pt]
$\|\vec{D}_T\|$ & Magnitude. \\
\bottomrule
\end{tabularx}`;
    expect(latexToMarkdown(source)).toBe(
      '| **Symbol** | **Meaning & Usage** |\n| --- | --- |\n| $P_{i-1}$ | Previous population. |\n| $\\Vert\\vec{D}_T\\Vert$ | Magnitude. |',
    );
  });

  it('retains tables with inconsistent column counts and unknown commands', () => {
    const source = String.raw`\begin{tabularx}{\linewidth}{XX}
A & B \\
\custom{incomplete}
\end{tabularx}`;
    expect(latexToMarkdown(source)).toBe(source);
  });

  it('preserves headings, references, lists, simple tables and math in the original fixture', () => {
    const source = readFileSync(
      resolve(__dirname, '../../test/fixtures/latex_full_coverage.tex'),
      'utf8',
    );
    const markdown = latexToMarkdown(source);
    for (const part of [
      '# Equations for Lesson 3: Upload Coverage',
      'See Section Document structure.',
      '(Note: Footnote content should remain visible.)',
      '> Quoted source text should become a Markdown blockquote.',
      '1. First nested step.',
      '| Term | Meaning |\n| --- | --- |\n| ODE | Ordinary differential equation |',
      String.raw`$\vec{u}=[4,\,1]$`,
      String.raw`\begin{aligned}`,
      String.raw`\begin{gathered}`,
    ]) {
      expect(markdown).toContain(part);
    }
  });
});
