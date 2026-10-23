import { escapeHtml } from '../shared/logic.ts';

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): Html {
  return new Html(value);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Html {
  let output = '';
  for (let index = 0; index < strings.length; index += 1) {
    output += strings[index];
    if (index < values.length) output += render(values[index]);
  }
  return new Html(output);
}

export function mount(element: Element | null, content: Html): void {
  if (element) element.innerHTML = content.value;
}
