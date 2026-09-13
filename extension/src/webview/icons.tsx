import type { StepCategory } from '../../../shared/activity-schema';

const paths: Record<StepCategory, string> = {
  reading: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H14l4 4v11.5A2.5 2.5 0 0 1 15.5 21h-9A2.5 2.5 0 0 1 4 18.5v-13zM14 3v4h4M8 12h8M8 16h5',
  searching: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 21 21',
  editing: 'M4 20h4l10.5-10.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4zM13 7l4 4',
  running: 'M4 5h16v12H4zM8 9l3 2.5L8 14M13 14h4M8 21h8',
  checking: 'M4 12l5 5L20 6',
  saving: 'M12 3v12M7 10l5 5 5-5M4 19h16',
  asking: 'M9.5 9a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1.3-1.5 2.5M12 17.5v.01M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z',
  planning: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  delegating: 'M8 7a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM16 5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM2.5 19a5.5 5.5 0 0 1 11 0M13 17a4 4 0 0 1 8 0',
  external: 'M14 4h6v6M20 4l-8 8M11 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5',
  browsing: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  thinking: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4A2.5 2.5 0 0 1 4 13.5v-8z',
  other: 'M12 4v16M4 12h16',
};

export function CategoryIcon({ category, size = 16 }: { category: StepCategory; size?: number }) {
  return (
    <svg className={`icon icon-${category}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[category] ?? paths.other} />
    </svg>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`chevron ${open ? 'open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 5l8 7-8 7" />
    </svg>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="in progress" />;
}
