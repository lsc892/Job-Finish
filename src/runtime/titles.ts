import { taskTitle } from '../core/model';

/** User text blocks only: image, tool-result, and assistant content cannot become titles. */
export function inputTitle(content: unknown): string | undefined {
  if (typeof content === 'string') return taskTitle(content);
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text') {
      const title = taskTitle(block.text);
      if (title) return title;
    }
  }
  return undefined;
}
