import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import s from './ui.module.css';

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className={s.field}>
      <span className={s.label}>{label}</span>
      {children}
      {error ? (
        <span className={s.error}>{error}</span>
      ) : hint ? (
        <span className={s.hint}>{hint}</span>
      ) : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={s.input} {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={s.textarea} {...props} />;
}
