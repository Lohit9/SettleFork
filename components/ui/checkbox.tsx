"use client";

import * as React from "react";
import { CheckIcon } from "lucide-react";

import { cn } from "./utils";

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

function Checkbox({
  className,
  checked,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (onCheckedChange) {
      onCheckedChange(e.target.checked);
    }
  };

  return (
    <label
      data-slot="checkbox"
      className={cn(
        "relative peer border bg-input-background dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer flex items-center justify-center",
        checked && "bg-primary text-primary-foreground border-primary",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={handleChange}
        className="sr-only"
        tabIndex={-1}
        onFocus={(e) => e.preventDefault()}
        {...props}
      />
      {checked && (
        <CheckIcon className="size-3.5 text-current" />
      )}
    </label>
  );
}

export { Checkbox };
