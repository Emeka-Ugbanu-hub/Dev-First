import { useEffect, useRef, useState } from 'react';

export function Switch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      className={`df-switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="df-switch-knob" />
    </button>
  );
}

export function SelectInput({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <select className="df-select" value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

export function TextInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  return (
    <input
      className="df-input"
      value={local}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => {
        const next = event.target.value;
        setLocal(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => onChange(next), 400);
      }}
    />
  );
}

export function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setLocal(String(value));
  }, [value]);

  return (
    <input
      className="df-input df-input-number"
      type="number"
      value={local}
      min={min}
      max={max}
      onChange={(event) => {
        const next = event.target.value;
        setLocal(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          const parsed = Number(next);
          if (Number.isFinite(parsed)) {
            onChange(parsed);
          }
        }, 400);
      }}
    />
  );
}
