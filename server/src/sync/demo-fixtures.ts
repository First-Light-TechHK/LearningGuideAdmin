/**
 * 外部源同步的演示 fixture（§3.2.2 外部源接管模型，Mock 数据源）。
 *
 * 设计：
 * - BASELINE_COURSES：本地 demo 课程的「基线内容」，被 prisma/seed-demo.ts 用于灌本地库。
 * - EXTERNAL_COURSES：模拟外部源（master）当前内容，由基线派生并刻意制造差异，
 *   使手动测试可覆盖全部同步分支（详见下方注释）。
 * - 未变更页直接复用基线同一字符串常量，保证「已同步/无变更」判定为字节级一致。
 *
 * 真实外部 API 接入（§12 事项 #4）后，替换 EXTERNAL_COURSES 数据源即可，同步算法不变。
 */

export interface ExtPage {
  title: string;
  contentMd: string;
  tags: string[];
}
export interface ExtLesson {
  title: string;
  pages: ExtPage[];
}
export interface ExtCourse {
  externalId: string;
  title: string;
  description: string;
  lessons: ExtLesson[];
}
export interface BaselineCourse {
  title: string;
  description: string;
  /** 关联的外部源 ID；null 表示本地独有课程（无外部源，不出现在同步选择器） */
  externalId: string | null;
  lessons: ExtLesson[];
}

// ---------- 页面内容常量（LaTeX 反斜杠按 TS 模板字符串规则转义为 \\） ----------

const POP_OVERVIEW = `Modeling life uses mathematics to describe how populations change over time. By building mathematical models, we can understand and predict the dynamics of biological systems, from bacteria in a petri dish to predator-prey populations in ecosystems.

Exponential growth is a simple model that applies when the growth rate is proportional to the current population size. It provides a useful starting point for understanding population dynamics, especially in environments where resources are not yet limited.

The core idea can be written as a differential equation:

$$\\frac{dP}{dt} = rP$$

where $P$ is the population at time $t$ and $r$ is the intrinsic growth rate.`;

const POP_OVERVIEW_UPDATED = `Modeling life uses mathematics to describe how populations change over time.

> 外部源改版（v2）：新增「基本假设」小节，并更新了微分方程表述。

The exponential model rests on two assumptions:
1. Resources are unlimited.
2. The per-capita growth rate $r$ is constant.

$$\\frac{dP}{dt} = rP \\quad\\Rightarrow\\quad P(t) = P_0 e^{rt}$$

where $P_0 = P(0)$ is the initial population.`;

const POP_QA_TABLE = `Common questions students ask when first meeting the exponential model:

| Question | Answer |
| --- | --- |
| What does $P(t)$ represent? | The population size at time $t$. |
| What does $r$ represent? | The intrinsic growth rate. |
| When is an exponential model appropriate? | When growth is proportional to resources and the population is not yet limiting. |
| What is a limitation of this model? | It ignores carrying capacity and environmental constraints. |`;

const POP_EXPONENTIAL = `Solving $\\frac{dP}{dt} = rP$ with initial condition $P(0) = P_0$ gives the classic exponential law:

$$P(t) = P_0 e^{rt}$$

Discrete version (e.g. yearly reproduction):

$$P_{n+1} = P_n + r P_n = (1+r)P_n$$

**Check your understanding**: if a bacteria culture doubles every 3 hours, what is $r$ in $P(t)=P_0 e^{rt}$? (Hint: solve $e^{3r}=2$.)`;

const POP_LOGISTIC = `A common misconception is that populations grow exponentially forever. In reality, limited resources slow growth as the population approaches the carrying capacity $K$:

$$\\frac{dP}{dt} = rP\\left(1 - \\frac{P}{K}\\right)$$

The solution is the S-shaped (sigmoid) curve:

$$P(t) = \\frac{K}{1 + \\left(\\frac{K-P_0}{P_0}\\right)e^{-rt}}$$

Note how the factor $\\left(1-\\frac{P}{K}\\right)$ damps growth: when $P \\to K$, the growth rate $\\to 0$.`;

const POP_NOTATION = `Notation used throughout this course:

- $t$ — time
- $P(t)$ — population at time $t$
- $r$ — intrinsic growth rate
- $K$ — carrying capacity

Keeping symbols consistent avoids most early mistakes.`;

const POP_ADVANCED = `Extensions beyond the basic models: the Allee effect, age-structured populations, and stochastic growth. These are covered in the advanced track.`;

const CALC_DERIV_DEF = `The derivative measures the instantaneous rate of change:

$$f'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}$$

Geometrically, $f'(a)$ is the slope of the tangent line to $y=f(x)$ at $x=a$.

- If $f(x) = x^2$, then $f'(x) = 2x$
- If $f(x) = \\sin x$, then $f'(x) = \\cos x$`;

const CALC_DERIV_RULES = `| Rule | Formula |
| --- | --- |
| Sum | $(f+g)' = f' + g'$ |
| Product | $(fg)' = f'g + fg'$ |
| Quotient | $\\left(\\frac{f}{g}\\right)' = \\frac{f'g - fg'}{g^2}$ |
| Chain | $\\frac{d}{dx} f(g(x)) = f'(g(x))\\,g'(x)$ |

Worked example (chain rule): $\\frac{d}{dx}\\sin(x^2) = \\cos(x^2)\\cdot 2x$.`;

const CALC_INTEGRALS = `The Fundamental Theorem of Calculus links derivatives and integrals:

$$\\int_a^b f(x)\\,dx = F(b) - F(a), \\quad F' = f$$

Example:

$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$

**Practice**: compute $\\int_0^{\\pi} \\sin x\\,dx$ and interpret the result as an area.`;

const MECH_NEWTON = `1. **Inertia**: a body remains at rest or in uniform motion unless acted on by a net force.
2. **F=ma**: the net force equals mass times acceleration:

$$\\vec{F} = m\\vec{a} = m\\frac{d\\vec{v}}{dt}$$

3. **Action-reaction**: forces come in equal and opposite pairs.

A frequent misconception: $\\vec{F}=m\\vec{v}$ (force proportional to velocity). Force is proportional to the *change* of velocity, not velocity itself.`;

const MECH_PROJECTILE = `With constant gravity and no air resistance:

$$x(t) = v_0 \\cos\\theta\\, t, \\qquad y(t) = v_0 \\sin\\theta\\, t - \\frac{1}{2}g t^2$$

The horizontal and vertical motions are **independent** — this is the key insight and a common stumbling block.`;

const MECH_ENERGY = `Net work equals the change in kinetic energy:

$$W_{net} = \\Delta K = \\frac{1}{2}mv^2 - \\frac{1}{2}mv_0^2$$

For conservative forces, mechanical energy is conserved:

$$K + U = \\text{const}$$

**Check**: a block slides down a frictionless ramp of height $h$. What is its speed at the bottom?`;

const LINALG_SPAN = `A set of vectors $\\{v_1, \\dots, v_k\\}$ spans a space if every vector in the space can be written as a linear combination:

$$v = c_1 v_1 + \\cdots + c_k v_k$$

Linear independence means the only solution to $c_1 v_1 + \\cdots + c_k v_k = 0$ is all $c_i = 0$.`;

const LINALG_MATRIX = `For $A \\in \\mathbb{R}^{m\\times n}$ and $B \\in \\mathbb{R}^{n\\times p}$:

$$(AB)_{ij} = \\sum_{k=1}^{n} A_{ik} B_{kj}$$

Key points:
- Matrix multiplication is **not commutative**: in general $AB \\neq BA$
- It **is** associative: $(AB)C = A(BC)$
- $AB$ means "apply $B$ first, then $A$" — read compositions right-to-left`;

const QUANTUM_POSTULATES = `The four postulates of quantum mechanics:

1. The state of a system is a unit vector $|\\psi\\rangle$ in a Hilbert space.
2. Observables correspond to Hermitian operators.
3. Measurement yields an eigenvalue, collapsing the state to the corresponding eigenvector.
4. States evolve unitarily via the Schrödinger equation:

$$i\\hbar \\frac{\\partial}{\\partial t}|\\psi\\rangle = \\hat{H}|\\psi\\rangle$$`;

const QUANTUNE_HARMONIC = `The quantum harmonic oscillator has equally spaced energy levels:

$$E_n = \\hbar\\omega\\left(n + \\tfrac{1}{2}\\right), \\quad n = 0, 1, 2, \\dots$$

The $\\tfrac{1}{2}\\hbar\\omega$ term is the zero-point energy — a purely quantum effect with no classical analogue.`;

// ---------- 本地基线课程（seed 灌库用） ----------

export const BASELINE_COURSES: BaselineCourse[] = [
  {
    title: 'Population Growth',
    description: 'Mathematical models of population dynamics',
    externalId: 'ext-population-001',
    lessons: [
      {
        title: 'Introduction',
        pages: [
          {
            title: 'Overview',
            contentMd: POP_OVERVIEW,
            tags: ['Core Knowledge'],
          },
          {
            title: 'Q&A Table',
            contentMd: POP_QA_TABLE,
            tags: ['Teaching Guidance'],
          },
        ],
      },
      {
        title: 'Mathematical Models',
        pages: [
          {
            title: 'Exponential Model',
            contentMd: POP_EXPONENTIAL,
            tags: ['Core Knowledge', 'Assessment'],
          },
          {
            title: 'Logistic Growth',
            contentMd: POP_LOGISTIC,
            tags: ['Misconception'],
          },
        ],
      },
    ],
  },
  {
    title: 'Calculus Fundamentals',
    description: 'Derivatives and integrals from first principles',
    externalId: 'ext-calculus-001',
    lessons: [
      {
        title: 'Derivatives',
        pages: [
          {
            title: 'Definition of the Derivative',
            contentMd: CALC_DERIV_DEF,
            tags: ['Core Knowledge'],
          },
          {
            title: 'Differentiation Rules',
            contentMd: CALC_DERIV_RULES,
            tags: ['Core Knowledge', 'Teaching Guidance'],
          },
        ],
      },
      {
        title: 'Integrals',
        pages: [
          {
            title: 'Antiderivatives & the FTC',
            contentMd: CALC_INTEGRALS,
            tags: ['Core Knowledge', 'Assessment'],
          },
        ],
      },
    ],
  },
  {
    title: 'Classical Mechanics',
    description: 'Newtonian mechanics: forces, motion, energy',
    externalId: null, // 本地独有，无外部源
    lessons: [
      {
        title: 'Kinematics & Laws',
        pages: [
          {
            title: "Newton's Laws",
            contentMd: MECH_NEWTON,
            tags: ['Core Knowledge'],
          },
          {
            title: 'Projectile Motion',
            contentMd: MECH_PROJECTILE,
            tags: ['Teaching Guidance', 'Misconception'],
          },
        ],
      },
      {
        title: 'Energy',
        pages: [
          {
            title: 'Work-Energy Theorem',
            contentMd: MECH_ENERGY,
            tags: ['Core Knowledge', 'Assessment'],
          },
        ],
      },
    ],
  },
  {
    title: 'Linear Algebra',
    description: 'Vectors, matrices and linear maps',
    externalId: null, // 本地独有，无外部源
    lessons: [
      {
        title: 'Vector Spaces',
        pages: [
          {
            title: 'Vectors & Span',
            contentMd: LINALG_SPAN,
            tags: ['Core Knowledge'],
          },
        ],
      },
      {
        title: 'Matrices',
        pages: [
          {
            title: 'Matrix Multiplication',
            contentMd: LINALG_MATRIX,
            tags: ['Core Knowledge', 'Teaching Guidance'],
          },
        ],
      },
    ],
  },
];

// ---------- 外部源课程（模拟 master，刻意制造差异） ----------

/**
 * 覆盖的同步分支：
 * - Population Growth（已同步、有更新）：
 *   · Overview 内容改版 → 本地页 STALE + 新增 "Overview-new"
 *   · Q&A Table / Exponential Model 不变 → 无操作
 *   · 新增页 Notation（Introduction 下）→ 新增
 *   · 删除 Logistic Growth → 本地该页 STALE（本地独有）
 *   · 新增章 Extensions（含 Advanced Topics）→ 新增
 * - Calculus Fundamentals：与本地完全一致 → unchanged（提示「已与外部源一致」）
 * - Quantum Basics：外部独有、本地未导入 → 选择器状态「未同步」，同步即整课导入
 */
export const EXTERNAL_COURSES: ExtCourse[] = [
  {
    externalId: 'ext-population-001',
    title: 'Population Growth',
    description: 'Mathematical models of population dynamics',
    lessons: [
      {
        title: 'Introduction',
        pages: [
          {
            title: 'Overview',
            contentMd: POP_OVERVIEW_UPDATED,
            tags: ['Core Knowledge'],
          }, // 改版
          {
            title: 'Q&A Table',
            contentMd: POP_QA_TABLE,
            tags: ['Teaching Guidance'],
          }, // 不变
          {
            title: 'Notation',
            contentMd: POP_NOTATION,
            tags: ['Core Knowledge'],
          }, // 新增页
        ],
      },
      {
        title: 'Mathematical Models',
        pages: [
          {
            title: 'Exponential Model',
            contentMd: POP_EXPONENTIAL,
            tags: ['Core Knowledge', 'Assessment'],
          }, // 不变
          // Logistic Growth 被外部删除 → 本地该页将变 STALE
        ],
      },
      {
        title: 'Extensions', // 新增章
        pages: [
          {
            title: 'Advanced Topics',
            contentMd: POP_ADVANCED,
            tags: ['Teaching Guidance'],
          },
        ],
      },
    ],
  },
  {
    externalId: 'ext-calculus-001',
    title: 'Calculus Fundamentals',
    description: 'Derivatives and integrals from first principles',
    lessons: BASELINE_COURSES[1].lessons, // 与本地完全一致
  },
  {
    externalId: 'ext-quantum-001',
    title: 'Quantum Basics',
    description: 'Introduction to quantum mechanics',
    lessons: [
      {
        title: 'Foundations',
        pages: [
          {
            title: 'Postulates',
            contentMd: QUANTUM_POSTULATES,
            tags: ['Core Knowledge'],
          },
          {
            title: 'Harmonic Oscillator',
            contentMd: QUANTUNE_HARMONIC,
            tags: ['Core Knowledge', 'Assessment'],
          },
        ],
      },
    ],
  },
];

export function listExternalCourses(): ExtCourse[] {
  return EXTERNAL_COURSES;
}

export function getExternalCourse(externalId: string): ExtCourse | undefined {
  return EXTERNAL_COURSES.find((c) => c.externalId === externalId);
}
