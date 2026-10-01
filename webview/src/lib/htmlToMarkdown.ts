const BLOCK_TAGS = 'p|div|section|article|header|footer';

export function htmlToMarkdown(html: string): string {
  let text = html;

  text = text.replace(/<pre[^>]*>\s*<code[^>]*class="[^"]*language-([\w-]+)[^"]*"[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_match, language, code) => {
    return `\n\n\`\`\`${language}\n${decodeEntities(stripTags(code))}\n\`\`\`\n\n`;
  });
  text = text.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_match, code) => {
    return `\n\n\`\`\`\n${decodeEntities(stripTags(code))}\n\`\`\`\n\n`;
  });

  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, content) => {
    return `\n\n${'#'.repeat(Number(level))} ${stripTags(content).trim()}\n\n`;
  });
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, content) => {
    return `\n\n${stripTags(content)
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n\n`;
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, content) => `\n- ${stripTags(content).trim()}`);
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
    const text = stripTags(label).trim();
    return href ? `[${text}](${href})` : text;
  });
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, content) => `**${stripTags(content).trim()}**`);
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, content) => `*${stripTags(content).trim()}*`);
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, code) => `\`${decodeEntities(stripTags(code))}\``);
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(new RegExp(`</?(?:${BLOCK_TAGS})[^>]*>`, 'gi'), '\n\n');
  text = stripTags(text);

  return decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, '');
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    try {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return String.fromCodePoint(parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) {
        return String.fromCodePoint(parseInt(entity.slice(1), 10));
      }
      return named[entity] ?? match;
    } catch {
      return match;
    }
  });
}
