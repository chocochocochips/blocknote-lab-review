import React, { useEffect, useState } from 'react';

export default function BlockSelectionTools({
  editor,
  container,
  enabled,
  selectedIds = [],
  onToggleBlock,
}) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!enabled && !selectedIds.length) {
      setRows([]);
      return;
    }
    const surface = container.current;
    if (!surface) return;
    let frame;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const parent = surface.getBoundingClientRect();
        setRows(
          editor.document
            .map((b, index) => {
              const el = surface.querySelector(`[data-id="${CSS.escape(b.id)}"]`);
              if (el) {
                el.classList.toggle('b05-selected', selectedIds.includes(b.id));
              }
              const r = el?.getBoundingClientRect();
              return r
                ? {
                    id: b.id,
                    index,
                    top: r.top - parent.top + surface.scrollTop,
                    height: r.height,
                  }
                : null;
            })
            .filter(Boolean),
        );
      });
    };
    const unsubscribe = editor.onChange(update);
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    surface.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    update();
    return () => {
      unsubscribe();
      observer.disconnect();
      surface.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      cancelAnimationFrame(frame);
      surface.querySelectorAll('.b05-selected').forEach(el => el.classList.remove('b05-selected'));
    };
  }, [editor, enabled, selectedIds]);

  if (!enabled) return null;

  return (
    <div className="block-select-layer" aria-label="문단 선택 도구">
      {rows.map(row => {
        const checked = selectedIds.includes(row.id);
        return (
          <div
            key={row.id}
            className={'block-select-tools' + (checked ? ' selected' : '')}
            style={{ top: row.top }}
          >
            <button
              type="button"
              aria-pressed={checked}
              aria-label={`문단 ${row.index + 1} 선택`}
              className={'block-select-btn' + (checked ? ' active' : '')}
              onPointerDown={e => e.preventDefault()}
              onClick={() => onToggleBlock(row.id)}
            >
              {checked ? '✓ 선택됨' : `문단 ${row.index + 1}`}
            </button>
          </div>
        );
      })}
    </div>
  );
}
