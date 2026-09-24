import { GoogleContent } from '../types.js';

const RETAIN_RECENT_CONTENTS = 16;
const MAX_ARCHIVE_CHARS = 32_000;
const MAX_PART_CHARS = 16_000;
const MAX_PARTS_PER_CONTENT = 12;

function abbreviate(text: string, maxChars = MAX_PART_CHARS): string {
  if (text.length <= maxChars) return text;
  const edge = Math.floor(maxChars / 2);
  return `${text.slice(0, edge)}\n\n[content omitted by automatic context compaction]\n\n${text.slice(-edge)}`;
}

function compactValue(value: any): any {
  if (typeof value === 'string') return abbreviate(value);
  if (Array.isArray(value)) return value.slice(0, MAX_PARTS_PER_CONTENT).map(compactValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compactValue(child)]));
}

function compactContent(content: GoogleContent): GoogleContent {
  const parts = content.parts.slice(0, MAX_PARTS_PER_CONTENT).map((part: any) => compactValue(part));
  if (content.parts.length > MAX_PARTS_PER_CONTENT) {
    parts.push({ text: '[additional content parts omitted by automatic context compaction]' });
  }
  return { role: content.role, parts };
}

function contentText(content: GoogleContent): string {
  return content.parts.map((part: any) => {
    if (typeof part.text === 'string') return part.text;
    if (part.functionCall) return `[tool call] ${JSON.stringify(part.functionCall)}`;
    if (part.functionResponse) return `[tool result] ${JSON.stringify(part.functionResponse)}`;
    return '';
  }).filter(Boolean).join('\n');
}

/** Compacts a request copy after Google confirms a context-overflow response. */
export function compactGoogleContents(contents: GoogleContent[]): GoogleContent[] | null {
  if (contents.length === 0) return null;

  const keepStart = Math.max(0, contents.length - RETAIN_RECENT_CONTENTS);
  const archived = contents.slice(0, keepStart);
  const recent = contents.slice(keepStart).map(compactContent);
  if (archived.length === 0) return recent;

  const archive = archived
    .map((content, index) => `${content.role === 'model' ? 'Assistant' : 'User'} #${index + 1}:\n${contentText(compactContent(content))}`)
    .join('\n\n');
  const excerpt = abbreviate(archive, MAX_ARCHIVE_CHARS);

  return [{
    role: 'user',
    parts: [{ text: `[Compressed conversation history. Treat this as background context; follow the current conversation and instructions.]\n${excerpt}` }]
  }, ...recent];
}

export function compactSystemInstruction(instruction: any): any {
  if (!instruction?.parts || !Array.isArray(instruction.parts)) return instruction;
  return {
    ...instruction,
    parts: instruction.parts.slice(0, MAX_PARTS_PER_CONTENT).map(compactValue)
  };
}

/** Tool declarations can be larger than the conversation itself, especially generated schemas. */
export function compactTools(tools: any): any {
  if (!Array.isArray(tools)) return tools;
  return tools.slice(0, 12).map((tool: any) => {
    if (!tool || typeof tool !== 'object') return tool;
    const declarations = Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : undefined;
    if (!declarations) return compactValue(tool);
    return {
      ...tool,
      functionDeclarations: declarations.slice(0, 64).map((declaration: any) => ({
        ...declaration,
        description: typeof declaration.description === 'string' ? abbreviate(declaration.description, 4_000) : declaration.description,
        parameters: compactValue(declaration.parameters)
      }))
    };
  });
}
