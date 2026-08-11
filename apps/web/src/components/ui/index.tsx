/**
 * The Outskill component set.
 *
 * Dark, high-contrast and restrained. The lime accent is reserved for primary
 * actions, active navigation, progress and success — never used as body text
 * and never as a decorative glow.
 *
 * Accessibility is owned here rather than inherited: every input is
 * label-associated, errors are wired with `aria-describedby` and `aria-invalid`,
 * status messages announce through live regions, and focus is always visible.
 */

import * as React from 'react';

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

// --------------------------------------------------------------------------
// Wordmark
// --------------------------------------------------------------------------

/** Text wordmark. No invented logo — the mark is the name, set confidently. */
export function Wordmark({
  size = 'md',
  subtitle,
}: {
  size?: 'sm' | 'md' | 'lg';
  subtitle?: string;
}) {
  const sizes = {
    sm: 'text-sm tracking-[0.28em]',
    md: 'text-base tracking-[0.3em]',
    lg: 'text-lg tracking-[0.32em]',
  } as const;

  return (
    <span className="inline-flex flex-col leading-tight">
      <span className={cn('font-black uppercase text-ink', sizes[size])}>
        OUTSKILL
      </span>
      {subtitle && (
        <span className="mt-0.5 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-brand">
          {subtitle}
        </span>
      )}
    </span>
  );
}

// --------------------------------------------------------------------------
// Button
// --------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // Lime on black — the only element that gets this treatment.
  primary:
    'bg-brand text-black font-bold hover:bg-brand-hover disabled:bg-surface-soft disabled:text-muted',
  secondary:
    'bg-surface-alt text-ink border border-line hover:bg-surface-soft hover:border-brand-edge disabled:text-muted',
  ghost: 'bg-transparent text-muted hover:bg-surface-alt hover:text-ink disabled:text-muted',
  danger:
    'bg-danger-tint text-danger border border-danger/50 font-semibold hover:bg-danger hover:text-black disabled:text-muted',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2.5 text-sm',
  lg: 'px-6 py-3 text-base',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-colors',
        'disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

// --------------------------------------------------------------------------
// Fields
// --------------------------------------------------------------------------

export interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (aria: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
    'aria-required': boolean | undefined;
  }) => React.ReactNode;
}

export function Field({ id, label, hint, error, required, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
        {required && (
          <span className="ml-1 text-brand" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {hint && (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required || undefined,
      })}
      {error && (
        <p id={errorId} className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL_BASE =
  'w-full rounded-[10px] border bg-canvas px-3 py-2.5 text-base text-ink placeholder:text-muted/70 ' +
  'transition-colors hover:border-line focus:border-brand ' +
  'disabled:cursor-not-allowed disabled:bg-surface-alt disabled:text-muted';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        {...props}
        className={cn(CONTROL_BASE, props['aria-invalid'] ? 'border-danger' : 'border-line', className)}
      />
    );
  },
);

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, rows = 4, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      {...props}
      className={cn(
        CONTROL_BASE,
        'resize-y',
        props['aria-invalid'] ? 'border-danger' : 'border-line',
        className,
      )}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      {...props}
      className={cn(CONTROL_BASE, props['aria-invalid'] ? 'border-danger' : 'border-line', className)}
    >
      {children}
    </select>
  );
});

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: React.ReactNode;
  description?: string;
}

export function Checkbox({ label, description, id, className, ...props }: CheckboxProps) {
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className={cn('flex gap-3', className)}>
      <input
        type="checkbox"
        id={id}
        aria-describedby={descriptionId}
        {...props}
        className="mt-1 h-5 w-5 shrink-0 rounded border-2 border-line bg-canvas accent-[var(--brand-accent)]"
      />
      <div className="space-y-0.5">
        <label htmlFor={id} className="block text-sm text-ink">
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="text-sm text-muted">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Surfaces
// --------------------------------------------------------------------------

export function Card({
  children,
  className,
  as: Component = 'div',
  tone = 'default',
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  as?: React.ElementType;
  tone?: 'default' | 'raised' | 'accent';
  /** Explicit test hook — arbitrary props are not spread onto the element. */
  testId?: string;
}) {
  const tones = {
    default: 'bg-surface border-line',
    raised: 'bg-surface-alt border-line',
    accent: 'bg-surface-alt border-brand-edge',
  } as const;

  return (
    <Component
      data-testid={testId}
      className={cn('rounded-[14px] border p-5 sm:p-6', tones[tone], className)}
    >
      {children}
    </Component>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  level = 2,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  level?: 2 | 3 | 4;
}) {
  const Heading = `h${level}` as const;
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <Heading className="text-lg font-bold text-ink">{title}</Heading>
        {description && <p className="mt-1.5 max-w-prose text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Page-level heading, used once per page. */
export function PageHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        {eyebrow && (
          <p className="mb-1.5 text-xs font-bold uppercase tracking-[0.16em] text-brand">{eyebrow}</p>
        )}
        <h1 className="text-2xl font-bold text-ink sm:text-3xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-soft text-muted border-line',
  success: 'bg-success-tint text-success border-success/40',
  warning: 'bg-warning-tint text-warning border-warning/40',
  danger: 'bg-danger-tint text-danger border-danger/40',
  info: 'bg-info-tint text-info border-info/40',
  accent: 'bg-brand-tint text-brand border-brand-edge',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        // `items-start` + `leading-tight` keeps a wrapped two-word label inside
        // the pill; `py-1` gives the second line somewhere to sit.
        'inline-flex items-start gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold leading-tight',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Cohort lifecycle status, styled by what the status means operationally. */
export function StatusPill({ status }: { status: string }) {
  const tone: BadgeTone =
    status === 'open'
      ? 'success'
      : status === 'judging'
        ? 'accent'
        : status === 'paused'
          ? 'warning'
          : status === 'finalised'
            ? 'info'
            : 'neutral';

  return (
    <Badge tone={tone}>
      <span
        aria-hidden="true"
        className={cn(
          'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
          tone === 'success' && 'bg-success',
          tone === 'accent' && 'bg-brand',
          tone === 'warning' && 'bg-warning',
          tone === 'info' && 'bg-info',
          tone === 'neutral' && 'bg-muted',
        )}
      />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

type AlertTone = 'info' | 'warning' | 'danger' | 'success' | 'accent';

const ALERT_TONES: Record<AlertTone, string> = {
  info: 'border-info/40 bg-info-tint text-info',
  warning: 'border-warning/40 bg-warning-tint text-warning',
  danger: 'border-danger/40 bg-danger-tint text-danger',
  success: 'border-success/40 bg-success-tint text-success',
  accent: 'border-brand-edge bg-brand-tint text-brand',
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: AlertTone;
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      // Errors interrupt; everything else waits for a pause in speech.
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('rounded-[10px] border-l-2 border border-l-4 p-4', ALERT_TONES[tone], className)}
    >
      {title && <p className="font-bold">{title}</p>}
      <div className={cn('text-sm', title && 'mt-1', tone !== 'danger' && 'text-ink/85')}>
        {children}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Table
// --------------------------------------------------------------------------

export function Table({ children, caption }: { children: React.ReactNode; caption?: string }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  scope = 'col',
}: {
  children: React.ReactNode;
  className?: string;
  scope?: 'col' | 'row';
}) {
  return (
    <th
      scope={scope}
      className={cn(
        'border-b border-line px-3 py-2.5 text-left text-xs font-bold uppercase tracking-wider text-muted',
        scope === 'row' && 'normal-case tracking-normal text-sm text-ink',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={cn('border-b border-line/60 px-3 py-3 align-top text-ink', className)}>
      {children}
    </td>
  );
}

// --------------------------------------------------------------------------
// Progress
// --------------------------------------------------------------------------

export function Progress({
  value,
  max = 100,
  label,
  showPercent = true,
}: {
  value: number;
  max?: number;
  label: string;
  showPercent?: boolean;
}) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span className="font-medium text-ink">{label}</span>
        {showPercent && <span className="font-mono text-muted">{percent}%</span>}
      </div>
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-soft"
      >
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Stat tile for dashboard metrics. */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'attention' | 'accent';
}) {
  return (
    <div
      className={cn(
        'rounded-[14px] border p-5',
        tone === 'attention' ? 'border-warning/40 bg-warning-tint' : 'border-line bg-surface',
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p
        className={cn(
          'mt-2 text-3xl font-bold tabular-nums',
          tone === 'accent' ? 'text-brand' : 'text-ink',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

// --------------------------------------------------------------------------
// Stepper
// --------------------------------------------------------------------------

export interface StepperStep {
  key: string;
  label: string;
  complete: boolean;
}

/**
 * Six-step submission progress.
 *
 * `orientation="vertical"` is the desktop side navigation; horizontal is the
 * compact mobile indicator.
 */
export function Stepper({
  steps,
  currentKey,
  onSelect,
  orientation = 'horizontal',
}: {
  steps: StepperStep[];
  currentKey: string;
  onSelect: (key: string) => void;
  /** `responsive` wraps horizontally on small screens and stacks on desktop. */
  orientation?: 'horizontal' | 'vertical' | 'responsive';
}) {
  return (
    <nav aria-label="Submission steps" data-testid="submission-stepper">
      <ol
        className={cn(
          'flex gap-2',
          orientation === 'vertical' && 'flex-col',
          orientation === 'horizontal' && 'flex-wrap',
          orientation === 'responsive' && 'flex-wrap lg:flex-col',
        )}
      >
        {steps.map((step, index) => {
          const isCurrent = step.key === currentKey;
          return (
            <li key={step.key}>
              <button
                type="button"
                onClick={() => onSelect(step.key)}
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left text-sm font-medium transition-colors',
                  orientation !== 'horizontal' && 'w-full',
                  isCurrent
                    ? 'border-brand-edge bg-brand-tint text-ink'
                    : 'border-transparent text-muted hover:bg-surface-alt hover:text-ink',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                    step.complete
                      ? 'bg-brand text-black'
                      : isCurrent
                        ? 'border border-brand text-brand'
                        : 'border border-line text-muted',
                  )}
                >
                  {step.complete ? '✓' : index + 1}
                </span>
                <span className={cn(orientation === 'horizontal' && 'hidden sm:inline')}>
                  {step.label}
                </span>
                <span className="sr-only">
                  {step.label}
                  {step.complete ? ' — complete' : ' — incomplete'}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// --------------------------------------------------------------------------
// Tabs — WAI-ARIA tabs pattern with roving tabindex
// --------------------------------------------------------------------------

export interface TabItem {
  key: string;
  label: string;
  badge?: React.ReactNode;
}

export function Tabs({
  tabs,
  activeKey,
  onChange,
  children,
}: {
  tabs: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  children: React.ReactNode;
}) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = tabs.findIndex((t) => t.key === activeKey);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;

    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onChange(target.key);
    refs.current[target.key]?.focus();
  };

  return (
    <div>
      <div
        role="tablist"
        onKeyDown={onKeyDown}
        className="-mx-1 flex flex-wrap gap-1 overflow-x-auto border-b border-line px-1"
      >
        {tabs.map((tab) => {
          const selected = tab.key === activeKey;
          return (
            <button
              key={tab.key}
              ref={(el) => {
                refs.current[tab.key] = el;
              }}
              role="tab"
              type="button"
              id={`tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`panel-${tab.key}`}
              // Roving tabindex: only the active tab is in the tab order.
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.key)}
              className={cn(
                'flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                selected
                  ? 'border-brand text-ink'
                  : 'border-transparent text-muted hover:border-line hover:text-ink',
              )}
            >
              {tab.label}
              {tab.badge}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`panel-${activeKey}`}
        aria-labelledby={`tab-${activeKey}`}
        tabIndex={0}
        className="pt-6"
      >
        {children}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Empty and descriptive
// --------------------------------------------------------------------------

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[14px] border border-dashed border-line bg-surface/50 p-10 text-center">
      <p className="font-semibold text-ink">{title}</p>
      {description && <p className="mx-auto mt-2 max-w-prose text-sm text-muted">{description}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

export function DescriptionList({
  items,
}: {
  items: { term: string; description: React.ReactNode }[];
}) {
  return (
    <dl className="grid gap-x-6 gap-y-3.5 sm:grid-cols-[minmax(9rem,auto)_1fr]">
      {items.map((item) => (
        <React.Fragment key={item.term}>
          <dt className="text-sm font-semibold text-muted">{item.term}</dt>
          <dd className="text-sm text-ink">{item.description}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden="true" />;
}

/**
 * Collapsible detail. Used to keep technical values available without putting
 * them in front of a programme operator.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  testId,
}: {
  summary: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  testId?: string;
}) {
  return (
    <details
      open={defaultOpen}
      data-testid={testId}
      className="group rounded-[10px] border border-line bg-surface-alt/60 [&[open]]:bg-surface-alt"
    >
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-muted transition-colors hover:text-ink">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
          {summary}
        </span>
      </summary>
      <div className="border-t border-line px-4 py-4">{children}</div>
    </details>
  );
}
