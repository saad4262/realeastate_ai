'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { setSkillSwitchAction } from '@/lib/skill-actions';
import styles from './skills.module.css';

/**
 * One platform skill's switch (ADR 0058). It moves at once and settles when the server answers;
 * a refusal puts it back and says why. The server checks can() again — this only draws the answer.
 */
export function SkillSwitch({ skillKey, name, on, disabled = false, onChange }: { skillKey: string; name: string; on: boolean; disabled?: boolean; onChange?: (on: boolean) => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  // Plain state, not useOptimistic: that snaps back to `on` when the action ends, so a switch inside a panel whose
  // `on` never changes jumped back to On. The prop still wins when the server's answer changes it.
  const [shown, setShown] = useState(on);
  useEffect(() => setShown(on), [on]);

  const flip = () =>
    startTransition(async () => {
      const next = !shown;
      setShown(next);
      const r = await setSkillSwitchAction(skillKey, next);
      if (!r.ok) {
        setShown(!next);
        toast({ title: 'Not changed', description: r.error, variant: 'error' });
        return;
      }
      onChange?.(next);
      toast({ title: `${name} is ${next ? 'on' : 'off'}`, variant: 'success' });
      router.refresh();
    });

  return (
    <button
      type="button"
      role="switch"
      aria-checked={shown}
      aria-label={name}
      className={styles.switch}
      disabled={disabled || pending}
      onClick={flip}
    />
  );
}
