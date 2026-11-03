'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { setConsumerSkillAction } from './actions';

/**
 * One skill's on/off switch. A client island only so the switch moves the moment it is pressed; the
 * server decides (`can()` and the catalog), and a refusal puts it back with the reason under it.
 */
export function SkillSwitch({ skillKey, name, on }: { skillKey: string; name: string; on: boolean }) {
  const [shown, setShown] = useOptimistic(on);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function flip() {
    setError(null);
    const next = !shown;
    startTransition(async () => {
      setShown(next);
      const result = await setConsumerSkillAction(skillKey, next);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        aria-label={`${name}: ${shown ? 'on' : 'off'}`}
        disabled={pending}
        onClick={flip}
        className={`relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--shell-accent,#0b3d2e)] disabled:opacity-70 ${
          shown ? 'bg-[var(--shell-accent,#0b3d2e)]' : 'bg-line'
        }`}
      >
        <span className={`inline-block size-5 rounded-full bg-white shadow transition-transform ${shown ? 'translate-x-[1.375rem]' : 'translate-x-0.5'}`} />
      </button>
      {error ? (
        <p role="alert" className="max-w-[14rem] text-right text-xs text-[#b42318]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
